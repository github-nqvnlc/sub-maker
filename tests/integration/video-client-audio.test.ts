import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '@/lib/db';
import { systemSettings, users, videoJobs, videoUploads } from '@/lib/db/schema';
import { updateSettings } from '@/lib/settings';
import { headObject } from '@/lib/storage/client';
import { storageKeys } from '@/lib/storage/keys';
import { runVideoPrepare } from '@/worker/jobs/video-prepare';
import { runVideoTranslate } from '@/worker/jobs/video-translate';
import { stopBoss } from '@/worker/queues';
import { startSonioxMock, type SonioxMock } from '../mocks/soniox-mock';
import { clearRateLimits, createAdmin, createUser, resetDb, type TestUser } from './helpers';
import { putSonioxConfig } from './stt-helpers';
import { createVideoJobApi, MB, uploadAll, videoFingerprint } from './video-api';
import { postExport } from './video-export-helpers';
import { errorOf, grantVideo, videoJobRow, videoUsed } from './video-helpers';
import { makeTestVideo } from './video-media';
import { cuesOf, FAST_PREPARE, FAST_TRANSLATE, videoUsage } from './video-pipeline-helpers';
import { newProject } from './voice-helpers';

/** Tách âm thanh trên máy người dùng (spec 006, T124; FR-003, FR-010, FR-011). */
let admin: TestUser;
let user: TestUser;
let projectId: string;
let mock: SonioxMock;
let tmp: string;

beforeAll(async () => {
  await resetDb();
  mock = await startSonioxMock();
  admin = await createAdmin();
  tmp = await mkdtemp(path.join(os.tmpdir(), 'client-audio-'));
}, 60_000);
afterAll(async () => {
  await mock.close();
  await stopBoss();
  await rm(tmp, { recursive: true, force: true });
});
beforeEach(async () => {
  await clearRateLimits();
  await getDb().delete(videoJobs);
  await getDb().update(users).set({ videoUsedBytes: 0 });
  await getDb().delete(systemSettings);
  mock.reset();
  await putSonioxConfig(admin, mock, 'ok', { enabled: true });
  user = await createUser();
  await grantVideo(admin, user.id);
  projectId = await newProject(user);
});

const ffmpeg = (args: string[]) => execFileSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-v', 'error', '-y', ...args]);
let n = 0;
async function makeAudio(ext: string, args: string[]): Promise<Buffer> {
  const file = path.join(tmp, `a${++n}.${ext}`);
  ffmpeg([...args, file]);
  return readFile(file);
}

async function uploadClientAudio(jobId: string, bytes: Buffer, opts: { ext?: string; mime?: string } = {}) {
  const ext = opts.ext ?? 'm4a';
  const mime = opts.mime ?? 'audio/mp4';
  const res = await user.client.post(`/api/video/jobs/${jobId}/client-audio`, {
    json: { size: bytes.length, fingerprint: await videoFingerprint(bytes), ext, mime },
  });
  expect(res.status, await res.clone().text()).toBe(201);
  const upload = (await res.json()) as { id: string; partSize: number; partCount: number };
  await uploadAll(user, upload, bytes);
  const done = await user.client.post(`/api/video/uploads/${upload.id}/complete`);
  expect(done.status, await done.clone().text()).toBe(200);
  return upload;
}

describe('phiên tải âm thanh trình duyệt', () => {
  it('từ chối > 500 MB và định dạng không hợp lệ', async () => {
    const src = await makeTestVideo({ seconds: 4 });
    const { job } = await createVideoJobApi(user, projectId, src, { clientAudio: true });

    const big = await user.client.post(`/api/video/jobs/${job.id}/client-audio`, {
      json: { size: 500 * MB + 1, fingerprint: 'b'.repeat(64), ext: 'm4a', mime: 'audio/mp4' },
    });
    expect(big.status).toBe(413);
    expect((await errorOf(big)).code).toBe('FILE_TOO_LARGE');

    const bad = await user.client.post(`/api/video/jobs/${job.id}/client-audio`, {
      json: { size: 1000, fingerprint: 'b'.repeat(64), ext: 'exe', mime: 'application/octet-stream' },
    });
    expect(bad.status).toBe(422);
    expect((await errorOf(bad)).code).toBe('MEDIA_UNSUPPORTED');
  });

  it('từ chối tệp không tin cậy và xóa tệp tạm mà không gọi Soniox', async () => {
    const src = await makeTestVideo({ seconds: 4 });
    const { job } = await createVideoJobApi(user, projectId, src, { clientAudio: true });
    const playlist = Buffer.from('#EXTM3U\nhttp://127.0.0.1:9999/secret.ts\n');
    await uploadClientAudio(job.id, playlist, { ext: 'm4a', mime: 'audio/mp4' });

    await runVideoPrepare(job.id, FAST_PREPARE);
    const row = (await videoJobRow(job.id))!;
    expect(row.status).toBe('failed');
    expect(row.errorCode).toBe('SOURCE_UNREADABLE');
    expect(mock.requests.filter((r) => r.path === '/v1/transcriptions')).toHaveLength(0);
    expect(await videoUsage(job.id)).toHaveLength(0);
    expect(await headObject(storageKeys.videoClientAudio(user.id, job.id, 'm4a'))).toBeNull();
  });

  it('từ chối âm thanh dài quá videoMaxMinutes trước khi gọi Soniox', async () => {
    await updateSettings({ videoMaxMinutes: 1 }, admin.id);
    const src = await makeTestVideo({ seconds: 4 });
    const { job } = await createVideoJobApi(user, projectId, src, { clientAudio: true });
    const longAudio = await makeAudio('m4a', ['-f', 'lavfi', '-i', 'sine=frequency=500:duration=65', '-c:a', 'aac']);
    await uploadClientAudio(job.id, longAudio, { ext: 'm4a', mime: 'audio/mp4' });

    await runVideoPrepare(job.id, FAST_PREPARE);
    const row = (await videoJobRow(job.id))!;
    expect(row.status).toBe('failed');
    expect(row.errorCode).toBe('VIDEO_TOO_LONG');
    expect(mock.requests.filter((r) => r.path === '/v1/transcriptions')).toHaveLength(0);
    expect(await videoUsage(job.id)).toHaveLength(0);
  });
});

describe('đối chiếu nguồn khi video tải xong (FR-010, FR-011, FR-003)', () => {
  it('dịch xong trước khi video tải xong; lệch mốc bắt đầu > 100 ms thì dời cue không tính phí lần hai', async () => {
    const src = await makeTestVideo({ seconds: 8, audioDelay: 1.5, audioSeconds: 6 });
    const { job, upload } = await createVideoJobApi(user, projectId, src, { clientAudio: true });
    const clientM4a = await makeAudio('m4a', ['-f', 'lavfi', '-i', 'sine=frequency=600:duration=6', '-c:a', 'aac']);
    await uploadClientAudio(job.id, clientM4a);

    await runVideoPrepare(job.id, FAST_PREPARE);
    await runVideoTranslate(job.id, FAST_TRANSLATE);

    let row = (await videoJobRow(job.id))!;
    expect(row.status).toBe('review_ready');
    expect(row.sourceState).toBe('uploading');
    expect(row.cueCount).toBeGreaterThan(0);
    expect(await videoUsage(job.id)).toHaveLength(1);
    const before = await cuesOf(job.id);

    // phụ đề đã tải được ngay khi video đang tải lên
    const srtRes = await user.client.get(`/api/video/jobs/${job.id}/subtitles?format=srt&content=target`);
    expect(srtRes.status).toBe(200);
    expect(await srtRes.text()).toContain('-->');

    // nay tải xong video nguồn có luồng tiếng bắt đầu ở 1,5 giây
    await uploadAll(user, upload, src);
    const done = await user.client.post(`/api/video/uploads/${upload.id}/complete`);
    expect(done.status).toBe(200);
    await runVideoPrepare(job.id, FAST_PREPARE);

    row = (await videoJobRow(job.id))!;
    expect(row.sourceState).toBe('ready');
    expect(row.audioMismatch).toBe(false);
    expect(row.cueRevision).toBe(before.length ? 2 : 1);
    const after = await cuesOf(job.id);
    expect(after).toHaveLength(before.length);
    const shift = row.media!.audioStartMs;
    expect(shift).toBeGreaterThan(1300);
    expect(after[0]!.startMs - before[0]!.startMs).toBeGreaterThanOrEqual(shift - 100);
    expect(mock.requests.filter((r) => r.path === '/v1/transcriptions')).toHaveLength(1);
    expect(await videoUsage(job.id)).toHaveLength(1);
  });

  it('tiếng ngắn hơn hình hợp lệ khi so với luồng tiếng nguồn thì KHÔNG đánh dấu lệch', async () => {
    const src = await makeTestVideo({ seconds: 6, audioSeconds: 3 });
    const { job, upload } = await createVideoJobApi(user, projectId, src, { clientAudio: true });
    const clientM4a = await makeAudio('m4a', ['-f', 'lavfi', '-i', 'sine=frequency=600:duration=3', '-c:a', 'aac']);
    await uploadClientAudio(job.id, clientM4a);
    await runVideoPrepare(job.id, FAST_PREPARE);
    await runVideoTranslate(job.id, FAST_TRANSLATE);

    await uploadAll(user, upload, src);
    expect((await user.client.post(`/api/video/uploads/${upload.id}/complete`)).status).toBe(200);
    await runVideoPrepare(job.id, FAST_PREPARE);

    const row = (await videoJobRow(job.id))!;
    expect(row.sourceState).toBe('ready');
    expect(row.audioMismatch).toBe(false);
  });

  it('lệch thời lượng > 1 giây so với luồng tiếng nguồn thì chờ xác nhận, xác nhận dịch lại mới tách lại từ nguồn và xóa cờ lệch', async () => {
    const src = await makeTestVideo({ seconds: 6, audioSeconds: 6 });
    const { job, upload } = await createVideoJobApi(user, projectId, src, { clientAudio: true });
    const shortClient = await makeAudio('m4a', ['-f', 'lavfi', '-i', 'sine=frequency=600:duration=3', '-c:a', 'aac']);
    await uploadClientAudio(job.id, shortClient);
    await runVideoPrepare(job.id, FAST_PREPARE);
    await runVideoTranslate(job.id, FAST_TRANSLATE);

    await uploadAll(user, upload, src);
    expect((await user.client.post(`/api/video/uploads/${upload.id}/complete`)).status).toBe(200);
    await runVideoPrepare(job.id, FAST_PREPARE);

    let row = (await videoJobRow(job.id))!;
    expect(row.audioMismatch).toBe(true);
    expect(await videoUsage(job.id)).toHaveLength(1);

    // xác nhận dịch lại → lấy âm thanh thật từ nguồn (6 giây) và xóa audioMismatch
    const re = await user.client.post(`/api/video/jobs/${job.id}/retranslate`, {
      json: { confirm: true, direction: 'to_vi', baseRevision: row.cueRevision },
    });
    expect(re.status).toBe(202);
    await runVideoPrepare(job.id, FAST_PREPARE);
    await runVideoTranslate(job.id, FAST_TRANSLATE);

    row = (await videoJobRow(job.id))!;
    expect(row.audioMismatch).toBe(false);
    expect(row.status).toBe('review_ready');
    expect(await videoUsage(job.id)).toHaveLength(2);
  });

  it('skip chuyển về luồng máy chủ và chỉ có đúng một bản ghi tính phí', async () => {
    const src = await makeTestVideo({ seconds: 4 });
    const { job, upload } = await createVideoJobApi(user, projectId, src, { clientAudio: true });
    const skip = await user.client.post(`/api/video/jobs/${job.id}/client-audio/skip`);
    expect(skip.status).toBe(200);
    expect((await videoJobRow(job.id))!.clientAudio).toBe(false);

    // bỏ qua sau khi đã tắt luồng nhanh: tải audio sau bị từ chối
    const dummy = await makeAudio('m4a', ['-f', 'lavfi', '-i', 'sine=frequency=500:duration=2', '-c:a', 'aac']);
    const denied = await user.client.post(`/api/video/jobs/${job.id}/client-audio`, {
      json: { size: dummy.length, fingerprint: await videoFingerprint(dummy), ext: 'm4a', mime: 'audio/mp4' },
    });
    expect(denied.status).toBe(409);

    await uploadAll(user, upload, src);
    expect((await user.client.post(`/api/video/uploads/${upload.id}/complete`)).status).toBe(200);
    await runVideoPrepare(job.id, FAST_PREPARE);
    await runVideoTranslate(job.id, FAST_TRANSLATE);

    const row = (await videoJobRow(job.id))!;
    expect(row.status).toBe('review_ready');
    expect(row.sourceState).toBe('ready');
    expect(await videoUsage(job.id)).toHaveLength(1);
  });

  it('video nguồn tải xong không đạt (FR-003): sourceState = rejected, trả dung lượng, vẫn tải được phụ đề', async () => {
    // tệp chỉ có tiếng, không có hình (vẫn mang đuôi .mp4)
    const audioOnlyMp4 = await makeAudio('mp4', ['-f', 'lavfi', '-i', 'sine=frequency=600:duration=4', '-c:a', 'aac']);
    const { job, upload } = await createVideoJobApi(user, projectId, audioOnlyMp4, { clientAudio: true });
    const clientM4a = await makeAudio('m4a', ['-f', 'lavfi', '-i', 'sine=frequency=600:duration=4', '-c:a', 'aac']);
    await uploadClientAudio(job.id, clientM4a);
    await runVideoPrepare(job.id, FAST_PREPARE);
    await runVideoTranslate(job.id, FAST_TRANSLATE);

    await uploadAll(user, upload, audioOnlyMp4);
    expect((await user.client.post(`/api/video/uploads/${upload.id}/complete`)).status).toBe(200);
    await runVideoPrepare(job.id, FAST_PREPARE);

    const row = (await videoJobRow(job.id))!;
    expect(row.sourceState).toBe('rejected');
    expect(row.sourceKey).toBeNull();
    expect(row.errorCode).toBe('VIDEO_UNSUPPORTED');
    expect(await videoUsed(user.id)).toBe(0);

    // xuất video bị khóa nhưng phụ đề vẫn tải được
    const exp = await postExport(user, job.id);
    expect(exp.status).toBe(409);
    const srt = await user.client.get(`/api/video/jobs/${job.id}/subtitles?format=srt&content=target`);
    expect(srt.status).toBe(200);
    expect(await srt.text()).toContain('-->');

    // mở lại danh sách upload không còn phiên mở
    const ups = await getDb().select().from(videoUploads).where(eq(videoUploads.jobId, job.id));
    expect(ups.every((u) => u.state === 'completed' || u.state === 'aborted')).toBe(true);
  });
});
