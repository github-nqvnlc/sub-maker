import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '@/lib/db';
import { systemSettings, usageRecords, users, videoProjectSettings } from '@/lib/db/schema';
import { headObject } from '@/lib/storage/client';
import { storageKeys } from '@/lib/storage/keys';
import { stopBoss } from '@/worker/queues';
import { runVideoPrepare } from '@/worker/jobs/video-prepare';
import { runVideoTranslate } from '@/worker/jobs/video-translate';
import { startSonioxMock, type SonioxMock } from '../mocks/soniox-mock';
import { clearRateLimits, createAdmin, createUser, resetDb, type TestUser } from './helpers';
import { putSonioxConfig, SONIOX_KEY } from './stt-helpers';
import { grantVideo, videoJobRow, videoUsed } from './video-helpers';
import { cuesOf, FAST_PREPARE, FAST_TRANSLATE, runPipeline, uploadedJob, videoLogKeys, videoUsage } from './video-pipeline-helpers';
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
