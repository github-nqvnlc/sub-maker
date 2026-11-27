import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { probeVideo } from '@/lib/audio/ffmpeg';
import { getDb } from '@/lib/db';
import { systemSettings, usageRecords, users, videoJobs, videoProjectSettings } from '@/lib/db/schema';
import { downloadObjectToFile, headObject } from '@/lib/storage/client';
import { storageKeys } from '@/lib/storage/keys';
import { stopBoss } from '@/worker/queues';
import { runVideoPrepare } from '@/worker/jobs/video-prepare';
import { runVideoPreview, type VideoPreviewOptions } from '@/worker/jobs/video-preview';
import { runVideoTranslate } from '@/worker/jobs/video-translate';
import { startSonioxMock, type SonioxMock } from '../mocks/soniox-mock';
import { clearRateLimits, createAdmin, createUser, resetDb, type TestUser } from './helpers';
import { putSonioxConfig, SONIOX_KEY } from './stt-helpers';
import { errorOf, grantVideo, insertVideoJob, videoJobRow, videoUsed } from './video-helpers';
import { cuesOf, FAST_PREPARE, FAST_TRANSLATE, runPipeline, uploadedJob, videoLogKeys, videoUsage } from './video-pipeline-helpers';
import type { TestVideoOptions } from './video-media';
import { newProject } from './voice-helpers';

/** Nhận dạng và dịch (spec 006, T030; FR-009, FR-012, FR-013, FR-014, FR-016, FR-017). Soniox luôn là bản giả. */
let admin: TestUser;
let user: TestUser;
let projectId: string;
let mock: SonioxMock;

beforeAll(async () => {
  await resetDb();
  mock = await startSonioxMock();
  admin = await createAdmin();
}, 60_000);
afterAll(async () => {
  await mock.close();
  await stopBoss();
});
beforeEach(async () => {
  await clearRateLimits();
  await getDb().delete(systemSettings);
  mock.reset();
  await putSonioxConfig(admin, mock, 'ok', { pricePerAudioHourUsd: 3.6, apiKey: SONIOX_KEY, enabled: true });
  user = await createUser();
  await grantVideo(admin, user.id);
  projectId = await newProject(user);
});

const startBody = () => JSON.parse(mock.requests.find((r) => r.method === 'POST' && r.path === '/v1/transcriptions')!.body) as Record<string, unknown>;
const storageUsed = async () => (await getDb().select({ n: users.storageUsedBytes }).from(users).where(eq(users.id, user.id)))[0]!.n;
const scenario = (s: string) => putSonioxConfig(admin, mock, s);

describe('yêu cầu gửi nhà cung cấp', () => {
  it('"Mọi ngôn ngữ → Việt": dịch một chiều sang vi, nhận diện ngôn ngữ, phân biệt người nói, kèm từ điển đã chụp', async () => {
    await getDb()
      .insert(videoProjectSettings)
      .values({
        projectId,
        ownerId: user.id,
        glossary: [
          { source: 'Sub Maker', target: '', keep: true },
          { source: 'teacher', target: 'thầy giáo', keep: false },
        ],
      });
    const job = await uploadedJob(user, projectId);
    await runPipeline(job.id);
    expect(startBody()).toMatchObject({
      model: 'stt-async-v6',
      translation: { type: 'one_way', target_language: 'vi' },
      enable_language_identification: true,
      enable_speaker_diarization: true,
      context: {
        translation_terms: [
          { source: 'Sub Maker', target: 'Sub Maker' },
          { source: 'teacher', target: 'thầy giáo' },
        ],
      },
      client_reference_id: job.id,
    });
    expect(startBody()).not.toHaveProperty('language_hints');
    // chỉ gửi âm thanh (MP3 tách ở máy chủ), không gửi hình
    const upload = mock.requests.find((r) => r.method === 'POST' && r.path === '/v1/files')!;
    expect(upload.bytes).toBeLessThan(job.size);
  });

  it('"Việt → Anh": dịch sang en, gợi ý tiếng Việt; không có từ điển thì không gửi ngữ cảnh', async () => {
    const job = await uploadedJob(user, projectId, { direction: 'vi_to_en' });
    await runPipeline(job.id);
    expect(startBody()).toMatchObject({ translation: { type: 'one_way', target_language: 'en' }, language_hints: ['vi'] });
    expect(startBody()).not.toHaveProperty('context');
    const cues = await cuesOf(job.id);
    expect(cues[0]).toMatchObject({ sourceText: 'Xin chào mọi người.', targetText: 'Hello everyone.', sourceLang: 'vi' });
  });
});

describe('kết quả', () => {
  it('chờ duyệt với kịch bản hai cột, một bản ghi tính phí, dữ liệu ở nhà cung cấp đã xóa', async () => {
    const job = await uploadedJob(user, projectId);
    const before = await storageUsed();
    await runPipeline(job.id);
    const row = (await videoJobRow(job.id))!;
    expect(row).toMatchObject({ status: 'review_ready', progressPercent: 50, sourceState: 'ready', cueCount: 3, cueRevision: 1, cueRun: 1, billedRun: 1, errorCode: null, sonioxFileId: null, sonioxTranscriptionId: null, model: 'stt-async-v6' });
    expect(row.media).toMatchObject({ width: 320, height: 180, audioCodec: 'aac' });
    expect(row.finishedAt).toBeInstanceOf(Date);

    const cues = await cuesOf(job.id);
    expect(cues.map((c) => [c.sourceText, c.targetText, c.timing, c.speaker])).toEqual([
      ['Hello everyone.', 'Xin chào mọi người.', 'measured', '1'],
      ['Today we learn something new.', 'Hôm nay chúng ta học điều mới.', 'measured', '1'],
      ['Thank you, teacher.', 'Cảm ơn thầy.', 'measured', '2'],
    ]);
    expect(cues[0]!.startMs).toBe(120);

    // chữ phụ đề tính vào hạn mức 500 MB (FR-055); video tính vào hạn mức video
    expect(row.scriptBytes).toBeGreaterThan(50);
    expect(await storageUsed()).toBe(before + row.scriptBytes);
    expect(await videoUsed(user.id)).toBe(job.size);

    const usage = await videoUsage(job.id);
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ ok: true, providerType: 'soniox', configScope: 'global', userId: user.id, projectId, unitsAudioSeconds: 9, model: 'stt-async-v6' });
    expect(usage[0]!.costEstimateUsd).toBeCloseTo((9 / 3600) * 3.6, 8);

    expect(mock.deleted.files.size).toBe(1);
    expect(mock.deleted.transcriptions.size).toBe(1);
    expect(await headObject(storageKeys.videoTranscript(user.id, job.id, 1))).toBeNull();
    expect(await headObject(storageKeys.videoAudio(user.id, job.id))).not.toBeNull();
    expect(await videoLogKeys(job.id)).toEqual(expect.arrayContaining(['uploadDone', 'preparing', 'probed', 'extracted', 'sending', 'translating', 'translated', 'segmenting', 'reviewReady']));
  });

  it('mỗi lần gọi lỗi ghi một bản ghi ok = false chi phí 0; thành công vẫn chỉ một bản tính phí', async () => {
    const job = await uploadedJob(user, projectId);
    await scenario('429-2');
    await runPipeline(job.id);
    expect((await videoJobRow(job.id))!.status).toBe('review_ready');
    const usage = await videoUsage(job.id);
    expect(usage.filter((u) => !u.ok)).toHaveLength(2);
    expect(usage.filter((u) => !u.ok).every((u) => u.costEstimateUsd === 0 && u.unitsAudioSeconds === 0)).toBe(true);
    expect(usage.filter((u) => u.ok)).toHaveLength(1);
  });

  it('tiếng bắt đầu muộn 1,5 giây: cue đầu bắt đầu quanh 1,5 giây', async () => {
    const job = await uploadedJob(user, projectId, { video: { seconds: 8, audioDelay: 1.5 } });
    await scenario('onset');
    await runPipeline(job.id);
    const [first] = await cuesOf(job.id);
    expect(first!.startMs).toBeGreaterThan(1400);
    expect(first!.startMs).toBeLessThan(1620);
  });

  it('không có lời nói: lỗi rõ ràng, vẫn ghi bản tính phí, xóa dữ liệu ở nhà cung cấp', async () => {
    const job = await uploadedJob(user, projectId);
    await scenario('empty');
    await runPipeline(job.id);
    expect(await videoJobRow(job.id)).toMatchObject({ status: 'failed', errorCode: 'NO_SPEECH_DETECTED', cueCount: 0, sonioxFileId: null });
    const usage = await videoUsage(job.id);
    expect(usage.map((u) => u.ok)).toEqual([true]);
    expect(mock.deleted.files.size).toBe(1);
  });

  it('video không có tiếng bị từ chối trước khi gọi dịch; dung lượng được trả lại', async () => {
    const job = await uploadedJob(user, projectId, { video: { audio: false } });
    await runPipeline(job.id);
    expect(await videoJobRow(job.id)).toMatchObject({ status: 'failed', errorCode: 'NO_AUDIO_STREAM', sourceState: 'rejected', sourceKey: null, sourceExpiresAt: null });
    expect(mock.requests).toHaveLength(0);
    expect(await videoUsage(job.id)).toHaveLength(0);
    expect(await videoUsed(user.id)).toBe(0);
    expect(await headObject(storageKeys.videoSource(user.id, job.id, 'mp4'))).toBeNull();
  });

  it('cấu hình bị tắt sau khi tải xong: lỗi, không gọi nhà cung cấp', async () => {
    const job = await uploadedJob(user, projectId);
    await runVideoPrepare(job.id, FAST_PREPARE);
    await admin.client.put('/api/admin/stt-config', { json: { enabled: false } });
    mock.reset();
    await runVideoTranslate(job.id, FAST_TRANSLATE);
    expect(await videoJobRow(job.id)).toMatchObject({ status: 'failed', errorCode: 'STT_NOT_CONFIGURED' });
    expect(mock.requests).toHaveLength(0);
  });

  it('quá số lượt dịch đồng thời thì xếp hàng', async () => {
    await admin.client.put('/api/admin/settings', { json: { maxConcurrentVideoTranslations: 1, videoMaxJobsPerUser: 5 } });
    const a = await uploadedJob(user, projectId);
    const b = await uploadedJob(user, projectId);
    await runVideoPrepare(a.id, FAST_PREPARE);
    await runVideoPrepare(b.id, FAST_PREPARE);
    await scenario('slow-8');
    const first = runVideoTranslate(a.id, { ...FAST_TRANSLATE, pollMs: 40, maxPollMs: 40 });
    await expect.poll(async () => (await videoJobRow(a.id))!.status).toBe('translating');
    const second = runVideoTranslate(b.id, FAST_TRANSLATE);
    await expect.poll(async () => (await videoLogKeys(b.id)).includes('waiting')).toBe(true);
    expect((await videoJobRow(b.id))!.status).toBe('queued');
    await Promise.all([first, second]);
    expect((await videoJobRow(a.id))!.status).toBe('review_ready');
    expect((await videoJobRow(b.id))!.status).toBe('review_ready');
  }, 60_000);

  it('khóa Soniox không xuất hiện trong nhật ký hay bản ghi sử dụng', async () => {
    const job = await uploadedJob(user, projectId);
    await scenario('401');
    await runPipeline(job.id);
    const dump = JSON.stringify([await videoJobRow(job.id), await videoUsage(job.id), await getDb().select().from(usageRecords)]) + JSON.stringify(await (await user.client.get(`/api/video/jobs/${job.id}`)).json());
    expect(dump).not.toContain(SONIOX_KEY);
  });
});

describe('bản xem trước (T061)', () => {
  /** MPEG-4 trong .avi: trình duyệt không phát được nên cần bản xem trước. */
  const AVI = { ext: 'avi' as const, size: '1920x1080', seconds: 3, videoCodec: ['-c:v', 'mpeg4', '-q:v', '5'], audioCodec: ['-c:a', 'libmp3lame'] };

  async function prepared(video: TestVideoOptions = AVI) {
    const job = await uploadedJob(user, projectId, { video, fileName: `phim.${video.ext ?? 'mp4'}` });
    const queued: string[] = [];
    await runVideoPrepare(job.id, { ...FAST_PREPARE, enqueuePreview: async (id) => queued.push(id) });
    return { job, queued };
  }
  const preview = (jobId: string, over: VideoPreviewOptions = {}) => runVideoPreview(jobId, { ...FAST_PREPARE, ...over });
  const previewKey = (jobId: string) => storageKeys.videoPreview(user.id, jobId);
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('nguồn không phát được: tạo bản 720p H.264 + AAC cùng thời lượng; dung lượng không tính vào hạn mức người dùng', async () => {
    const { job, queued } = await prepared();
    expect(queued).toEqual([job.id]);
    expect((await videoJobRow(job.id))!.previewState).toBe('pending');
    const used = await videoUsed(user.id);
    await preview(job.id);
    const row = (await videoJobRow(job.id))!;
    expect(row).toMatchObject({ previewState: 'ready', previewKey: previewKey(job.id), previewHeartbeatAt: null });
    expect(row.previewBytes).toBe((await headObject(previewKey(job.id)))!.size);
    expect(await videoUsed(user.id)).toBe(used);

    const dir = await mkdtemp(path.join(os.tmpdir(), 'pv-'));
    try {
      const file = path.join(dir, 'p.mp4');
      await downloadObjectToFile(row.previewKey!, file);
      const media = await probeVideo(file, { demuxer: 'mov', maxMinutes: 5 });
      expect(media).toMatchObject({ width: 1280, height: 720, videoCodec: 'h264', audioCodec: 'aac', browserPlayable: true });
      expect(Math.abs(media.durationMs - row.media!.durationMs)).toBeLessThan(150);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    expect(await videoLogKeys(job.id)).toEqual(expect.arrayContaining(['previewStarted', 'previewDone']));
    // gọi lại không làm gì thêm
    await preview(job.id);
    expect((await videoJobRow(job.id))!.previewAttempt).toBe(1);
  }, 60_000);

  it('nguồn phát được, nhỏ và nhẹ thì không tạo bản xem trước', async () => {
    const { job, queued } = await prepared({ seconds: 2 });
    expect(queued).toEqual([]);
    await preview(job.id);
    expect((await videoJobRow(job.id))!.previewState).toBe('none');
    expect(await headObject(previewKey(job.id))).toBeNull();
  });

  it('lỗi kho tạm thời thì thử lại; tệp không đọc được thì báo hỏng ngay, không chặn việc dịch', async () => {
    const { job } = await prepared();
    let calls = 0;
    await preview(job.id, {
      download: async (key, file) => {
        if (++calls < 3) throw new Error('ECONNRESET');
        await downloadObjectToFile(key, file);
      },
    });
    expect((await videoJobRow(job.id))!.previewState).toBe('ready');
    expect(calls).toBe(3);

    await runVideoTranslate(job.id, FAST_TRANSLATE); // mỗi người một việc đang chạy
    const second = await prepared();
    let tries = 0;
    await preview(second.job.id, {
      download: async (_key, file) => {
        tries++;
        await writeFile(file, 'khong phai video');
      },
    });
    expect(tries).toBe(1);
    expect(await videoJobRow(second.job.id)).toMatchObject({ previewState: 'failed', previewKey: null });
    await runVideoTranslate(second.job.id, FAST_TRANSLATE);
    expect((await videoJobRow(second.job.id))!.status).toBe('review_ready');
  }, 60_000);

  it('thu hồi quyền giữa chừng: dừng, không để lại tệp', async () => {
    const { job } = await prepared();
    await preview(job.id, {
      download: async (key, file) => {
        await downloadObjectToFile(key, file);
        await grantVideo(admin, user.id, false);
        await pause(500);
      },
    });
    expect((await videoJobRow(job.id))!.previewState).toBe('failed');
    expect(await headObject(previewKey(job.id))).toBeNull();
  });

  it('việc bị xóa giữa chừng: dừng, không để lại tệp', async () => {
    const { job } = await prepared();
    await preview(job.id, {
      download: async (key, file) => {
        await downloadObjectToFile(key, file);
        expect((await user.client.delete(`/api/video/jobs/${job.id}`)).status).toBe(204);
        await pause(500);
      },
    });
    expect(await videoJobRow(job.id)).toBeUndefined();
    expect(await headObject(previewKey(job.id))).toBeNull();
  });

  it('người dùng dừng việc: bản xem trước dừng theo; chạy lại thì được xếp tạo lại', async () => {
    const { job } = await prepared();
    await preview(job.id, {
      download: async (key, file) => {
        await downloadObjectToFile(key, file);
        expect((await user.client.post(`/api/video/jobs/${job.id}/stop`)).status).toBe(200);
        await pause(500);
      },
    });
    expect((await videoJobRow(job.id))!.previewState).toBe('failed');
    expect((await user.client.post(`/api/video/jobs/${job.id}/rerun`)).status).toBe(202);
    expect(await videoJobRow(job.id)).toMatchObject({ previewState: 'pending', previewAttempt: 0 });
    await preview(job.id);
    expect((await videoJobRow(job.id))!.previewState).toBe('ready');
  }, 60_000);
});

describe('từ điển của Project (T103, T105; FR-019 đến FR-021)', () => {
  const putSettings = (who: TestUser, json: unknown) => who.client.put(`/api/projects/${projectId}/video/settings`, { json });
  const saved = async () => (await getDb().select().from(videoProjectSettings).where(eq(videoProjectSettings.projectId, projectId)))[0]?.glossary;

  it('lưu bản đã chuẩn hóa; việc mới trong Project chụp từ điển; sửa sau đó không đổi việc đã tạo', async () => {
    const res = await putSettings(user, { glossary: [{ source: '  Sub Maker ', target: '', keep: true }, { source: 'teacher', target: ' thầy giáo ', keep: false }] });
    expect(res.status).toBe(200);
    const pairs = [
      { source: 'Sub Maker', target: 'Sub Maker', keep: true },
      { source: 'teacher', target: 'thầy giáo', keep: false },
    ];
    expect(((await res.json()) as { glossary: unknown }).glossary).toEqual(pairs);
    expect(await saved()).toEqual(pairs);
    const job = await uploadedJob(user, projectId);
    expect((await videoJobRow(job.id))!.glossary).toEqual(pairs);
    await putSettings(user, { glossary: [] });
    expect((await videoJobRow(job.id))!.glossary).toEqual(pairs);
  });

  it('cặp sai trả 422 GLOSSARY_INVALID kèm thứ tự cặp, không ghi gì; người khác nhận 404', async () => {
    const res = await putSettings(user, { glossary: [{ source: 'a', target: 'b', keep: false }, { source: 'A', target: 'c', keep: false }, { source: '', target: 'd', keep: false }] });
    expect(res.status).toBe(422);
    expect(await errorOf(res)).toMatchObject({ code: 'GLOSSARY_INVALID', fields: { '2': 'duplicate', '3': 'missing' } });
    expect(await saved()).toBeUndefined();
    const other = await createUser();
    expect((await putSettings(other, { glossary: [] })).status).toBe(404);
  });

  it('giới hạn đọc từ cài đặt: đổi cài đặt thì giới hạn đổi theo', async () => {
    const two = [{ source: 'a', target: 'b', keep: false }, { source: 'c', target: 'd', keep: false }];
    expect((await putSettings(user, { glossary: two })).status).toBe(200);
    expect((await admin.client.put('/api/admin/settings', { json: { videoGlossaryMaxPairs: 1 } })).status).toBe(200);
    const res = await putSettings(user, { glossary: two });
    expect(res.status).toBe(422);
    expect((await errorOf(res)).code).toBe('GLOSSARY_TOO_LARGE');
  });
});

describe('dịch lại (T103, T105; FR-016, FR-021)', () => {
  const estimateOf = (who: TestUser, id: string) => who.client.post(`/api/video/jobs/${id}/retranslate/estimate`);
  const retranslate = (who: TestUser, id: string, json: unknown) => who.client.post(`/api/video/jobs/${id}/retranslate`, { json });
  const transcriptions = () => mock.requests.filter((r) => r.method === 'POST' && r.path === '/v1/transcriptions').map((r) => JSON.parse(r.body) as Record<string, unknown>);

  async function translatedJob() {
    const job = await uploadedJob(user, projectId);
    await runPipeline(job.id);
    return { id: job.id, row: (await videoJobRow(job.id))! };
  }

  it('ước tính theo thời lượng âm thanh và đơn giá; chưa có đơn giá thì chi phí là null', async () => {
    const { id, row } = await translatedJob();
    const res = await estimateOf(user, id);
    expect(res.status).toBe(200);
    const ms = row.media!.audioDurationMs;
    expect(await res.json()).toEqual({ durationMs: ms, costEstimateUsd: expect.closeTo((Math.round(ms / 1000) / 3600) * 3.6, 6) });
    await putSonioxConfig(admin, mock, 'ok', { pricePerAudioHourUsd: null });
    expect(await (await estimateOf(user, id)).json()).toEqual({ durationMs: ms, costEstimateUsd: null });
  });

  it('thay toàn bộ cue bằng kết quả mới theo hướng và từ điển mới, ghi thêm đúng một bản tính phí; cue cũ giữ tới lúc đó', async () => {
    const { id, row } = await translatedJob();
    const before = await cuesOf(id);
    await user.client.put(`/api/projects/${projectId}/video/settings`, { json: { glossary: [{ source: 'teacher', target: 'cô giáo', keep: false }] } });

    const res = await retranslate(user, id, { confirm: true, direction: 'vi_to_en', baseRevision: row.cueRevision });
    expect(res.status).toBe(202);
    const queued = (await videoJobRow(id))!;
    expect(queued).toMatchObject({ status: 'queued', translationRun: 2, direction: 'vi_to_en', sonioxFileId: null, sonioxTranscriptionId: null, glossary: [{ source: 'teacher', target: 'cô giáo', keep: false }] });
    expect(await cuesOf(id)).toEqual(before);

    await runVideoTranslate(id, FAST_TRANSLATE);
    const done = (await videoJobRow(id))!;
    expect(done).toMatchObject({ status: 'review_ready', cueRun: 2, billedRun: 2, cueRevision: row.cueRevision + 1 });
    expect((await cuesOf(id)).map((c) => c.targetText)).not.toEqual(before.map((c) => c.targetText));
    expect((await videoUsage(id)).filter((u) => u.ok)).toHaveLength(2);
    expect(transcriptions().at(-1)).toMatchObject({ translation: { target_language: 'en' }, context: { translation_terms: [{ source: 'teacher', target: 'cô giáo' }] } });
  });

  it('lượt mới lỗi thì giữ nguyên cue cũ và sửa tiếp được', async () => {
    const { id, row } = await translatedJob();
    const before = await cuesOf(id);
    await scenario('401');
    expect((await retranslate(user, id, { confirm: true, direction: 'to_vi', baseRevision: row.cueRevision })).status).toBe(202);
    await runVideoTranslate(id, FAST_TRANSLATE);
    expect((await videoJobRow(id))!).toMatchObject({ status: 'failed', cueRun: 1, errorCode: 'SONIOX_AUTH' });
    expect(await cuesOf(id)).toEqual(before);
  });

  it('thiếu xác nhận, phiên bản cũ, đang chạy, mất nguồn, thiếu quyền, của người khác: bị từ chối, không đổi gì', async () => {
    const { id, row } = await translatedJob();
    const body = { confirm: true, direction: 'to_vi', baseRevision: row.cueRevision };
    for (const bad of [{ ...body, confirm: false }, { direction: 'to_vi', baseRevision: row.cueRevision }, { ...body, direction: 'x' }]) expect((await retranslate(user, id, bad)).status).toBe(422);

    let res = await retranslate(user, id, { ...body, baseRevision: row.cueRevision + 1 });
    expect([res.status, (await errorOf(res)).code]).toEqual([409, 'CUE_CONFLICT']);

    const other = await createUser();
    await grantVideo(admin, other.id);
    expect((await retranslate(other, id, body)).status).toBe(404);
    expect((await retranslate(admin, id, body)).status).toBe(404);
    expect((await estimateOf(other, id)).status).toBe(404);

    await grantVideo(admin, user.id, false);
    res = await retranslate(user, id, body);
    expect([res.status, (await errorOf(res)).code]).toEqual([403, 'VIDEO_NOT_ALLOWED']);
    await grantVideo(admin, user.id);

    await getDb().update(videoJobs).set({ sourceState: 'deleted', sourceKey: null, audioTempKey: null }).where(eq(videoJobs.id, id));
    res = await retranslate(user, id, body);
    expect([res.status, (await errorOf(res)).code]).toEqual([409, 'VIDEO_SOURCE_GONE']);

    await getDb().update(videoJobs).set({ sourceState: 'ready', status: 'translating' }).where(eq(videoJobs.id, id));
    res = await retranslate(user, id, body);
    expect([res.status, (await errorOf(res)).code]).toEqual([409, 'VIDEO_NOT_EDITABLE']);
    expect((await videoJobRow(id))!.translationRun).toBe(1);
  });

  it('đang có việc khác chạy thì từ chối theo giới hạn số việc', async () => {
    const { id, row } = await translatedJob();
    await insertVideoJob(user.id, projectId, { status: 'queued' });
    const res = await retranslate(user, id, { confirm: true, direction: 'to_vi', baseRevision: row.cueRevision });
    expect([res.status, (await errorOf(res)).code]).toEqual([429, 'VIDEO_TOO_MANY_JOBS']);
  });

  it('chưa cấu hình Soniox thì từ chối, không đổi gì', async () => {
    const { id, row } = await translatedJob();
    await putSonioxConfig(admin, mock, 'ok', { enabled: false });
    const res = await retranslate(user, id, { confirm: true, direction: 'to_vi', baseRevision: row.cueRevision });
    expect([res.status, (await errorOf(res)).code]).toEqual([409, 'STT_NOT_CONFIGURED']);
    expect((await videoJobRow(id))!.status).toBe('review_ready');
  });
});
