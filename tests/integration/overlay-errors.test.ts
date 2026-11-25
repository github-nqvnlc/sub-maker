import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi as vitest } from 'vitest';
import { getDb } from '@/lib/db';
import { overlayJobLogs, overlayJobs, systemSettings } from '@/lib/db/schema';
import { deleteObject, putObject } from '@/lib/storage/client';
import { storageKeys } from '@/lib/storage/keys';
import { runRenderOverlay } from '@/worker/jobs/render-overlay';
import { childEnv } from '@/worker/render/spawn-render';
import { stopBoss } from '@/worker/queues';
import { clearRateLimits, createUser, resetDb, type TestUser } from './helpers';
import { FAST_RENDER, fakeRender } from './overlay-fake-render';
import { createOverlayJob, keysOf, makeVoice, overlayLogKeys, overlayRow, uploadSrt } from './overlay-helpers';
import { newProject } from './voice-helpers';

/** Phân loại lỗi, thử lại, nguồn bị xóa (spec 005, FR-038, FR-039, T032). */
let user: TestUser;
let projectId: string;
let fileId: string;
let voiceId: string;
let voiceJobId: string;

beforeAll(async () => {
  await resetDb();
}, 60_000);
afterAll(async () => {
  await stopBoss();
});
beforeEach(async () => {
  await clearRateLimits();
  await getDb().delete(systemSettings);
  await getDb().delete(overlayJobs);
  vitest.spyOn(console, 'error').mockImplementation(() => undefined);
  user = await createUser();
  projectId = await newProject(user);
  fileId = await uploadSrt(user, projectId);
  ({ voiceId, voiceJobId } = await makeVoice(user, projectId, fileId));
});

const newJob = () => createOverlayJob(user, projectId, { fileId, voiceId });
const result = async (id: string) => {
  const r = (await overlayRow(id))!;
  return { status: r.status, code: r.errorCode };
};

describe('lỗi tạm thời', () => {
  it('RENDER_FAILED hai lần rồi thành công: thử lại và hoàn tất', async () => {
    const job = await newJob();
    const fake = fakeRender({ outcomes: ['RENDER_FAILED', 'RENDER_FAILED', 'ok'] });
    await runRenderOverlay(job.id, { ...FAST_RENDER, spawnRender: fake.spawn });
    expect(fake.calls).toBe(3);
    expect(await result(job.id)).toEqual({ status: 'completed', code: null });
    expect((await overlayLogKeys(job.id)).filter((k) => k === 'retrying')).toHaveLength(2);
  });

  it('RENDER_FAILED mãi: thử lại tối đa 3 lần', async () => {
    const job = await newJob();
    const fake = fakeRender({ outcomes: Array(10).fill('RENDER_FAILED') });
    await runRenderOverlay(job.id, { ...FAST_RENDER, spawnRender: fake.spawn });
    expect(fake.calls).toBe(4);
    expect(await result(job.id)).toEqual({ status: 'failed', code: 'RENDER_FAILED' });
  });

  it('kho lưu trữ lỗi lúc ghi video: thử lại tối đa 3 lần rồi STORAGE_UNAVAILABLE', async () => {
    const job = await newJob();
    let puts = 0;
    const fake = fakeRender();
    await runRenderOverlay(job.id, {
      ...FAST_RENDER,
      spawnRender: fake.spawn,
      putObject: async () => {
        puts++;
        throw new Error('ECONNREFUSED 10.0.0.5:9000');
      },
    });
    expect(puts).toBe(4);
    expect(await result(job.id)).toEqual({ status: 'failed', code: 'STORAGE_UNAVAILABLE' });
  });
});

describe('lỗi vĩnh viễn không thử lại', () => {
  it.each(['QUOTA_EXCEEDED', 'AUDIO_UNREADABLE', 'DISK_FULL'] as const)('%s', async (code) => {
    const job = await newJob();
    const fake = fakeRender({ outcomes: [code, 'ok'] });
    await runRenderOverlay(job.id, { ...FAST_RENDER, spawnRender: fake.spawn });
    expect(fake.calls).toBe(1);
    expect(await result(job.id)).toEqual({ status: 'failed', code });
    expect(await overlayLogKeys(job.id)).not.toContain('retrying');
  });

  it('không đủ chỗ trống đĩa → DISK_FULL trước khi dựng', async () => {
    const job = await newJob();
    const fake = fakeRender();
    await runRenderOverlay(job.id, { ...FAST_RENDER, spawnRender: fake.spawn, freeBytes: async () => 1000 });
    expect(fake.calls).toBe(0);
    expect(await result(job.id)).toEqual({ status: 'failed', code: 'DISK_FULL' });
  });

  it('đối tượng âm thanh đã mất → AUDIO_UNREADABLE', async () => {
    const job = await newJob();
    await deleteObject(storageKeys.voice(user.id, voiceId));
    const fake = fakeRender();
    await runRenderOverlay(job.id, { ...FAST_RENDER, spawnRender: fake.spawn });
    expect(fake.calls).toBe(0);
    expect(await result(job.id)).toEqual({ status: 'failed', code: 'AUDIO_UNREADABLE' });
  });

  it('âm thanh hỏng: tiến trình con thật báo AUDIO_UNREADABLE', async () => {
    const job = await newJob();
    await putObject(storageKeys.voice(user.id, voiceId), Buffer.from('đây không phải mp3'.repeat(200)), 'audio/mpeg');
    await runRenderOverlay(job.id, { ...FAST_RENDER, heartbeatMs: 200 });
    expect(await result(job.id)).toEqual({ status: 'failed', code: 'AUDIO_UNREADABLE' });
  }, 60_000);
});

describe('nguồn bị xóa', () => {
  it('xóa voice khi đang chờ → SOURCE_DELETED khi worker nhận', async () => {
    const job = await newJob();
    expect((await user.client.delete(`/api/jobs/${voiceJobId}`)).status).toBeLessThan(300);
    const fake = fakeRender();
    await runRenderOverlay(job.id, { ...FAST_RENDER, spawnRender: fake.spawn });
    expect(fake.calls).toBe(0);
    expect(await result(job.id)).toEqual({ status: 'failed', code: 'SOURCE_DELETED' });
  });

  it('xóa voice khi đang chạy → dừng và báo SOURCE_DELETED', async () => {
    const job = await newJob();
    const fake = fakeRender({ hold: true });
    const running = runRenderOverlay(job.id, { ...FAST_RENDER, spawnRender: fake.spawn });
    await fake.started;
    await user.client.delete(`/api/jobs/${voiceJobId}`);
    await running;
    expect(fake.cancelled).toBeGreaterThan(0);
    expect(await result(job.id)).toEqual({ status: 'failed', code: 'SOURCE_DELETED' });
    expect(await keysOf(user.id, 'overlay/')).toEqual([]);
  });

  it('xóa kịch bản khi đang chạy → SOURCE_DELETED; video đã xuất xong không bị ảnh hưởng', async () => {
    const other = await uploadSrt(user, projectId, undefined, 'khac.srt');
    const done = await createOverlayJob(user, projectId, { fileId: other, voiceId });
    await runRenderOverlay(done.id, { ...FAST_RENDER, spawnRender: fakeRender().spawn });
    const job = await createOverlayJob(user, projectId, { fileId: other, voiceId });
    const fake = fakeRender({ hold: true });
    const running = runRenderOverlay(job.id, { ...FAST_RENDER, spawnRender: fake.spawn });
    await fake.started;
    expect((await user.client.delete(`/api/files/${other}`)).status).toBeLessThan(300);
    await running;
    expect(await result(job.id)).toEqual({ status: 'failed', code: 'SOURCE_DELETED' });
    expect(await result(done.id)).toEqual({ status: 'completed', code: null });
    expect((await user.client.get(`/api/overlay/jobs/${done.id}/video`)).status).toBe(200);
  });
});

describe('không lộ chi tiết nội bộ (FR-039)', () => {
  it('nhật ký và API chỉ có mã lỗi, không có đường dẫn hay khóa', async () => {
    const job = await newJob();
    await runRenderOverlay(job.id, { ...FAST_RENDER, spawnRender: fakeRender({ outcomes: ['AUDIO_UNREADABLE'] }).spawn });
    const logs = await getDb().select().from(overlayJobLogs).where(eq(overlayJobLogs.jobId, job.id));
    const detail = await (await user.client.get(`/api/overlay/jobs/${job.id}`)).text();
    for (const text of [JSON.stringify(logs), detail]) {
      expect(text).not.toContain('bi-mat');
      expect(text).not.toContain('sk-secret');
      expect(text).not.toMatch(/submaker-overlay-|users\/|\.mp3"/);
    }
  });

  it('tiến trình con chỉ nhận biến môi trường cho phép', () => {
    const env = childEnv({ PATH: '/bin', DATABASE_URL: 'postgres://u:p@h/db', S3_SECRET_KEY: 's', APP_ENCRYPTION_KEY: 'k', AUTH_SECRET: 'a', FFMPEG_PATH: '/ff', NODE_ENV: 'test' });
    expect(env).toEqual({ PATH: '/bin', FFMPEG_PATH: '/ff', NODE_ENV: 'test' });
  });
});
