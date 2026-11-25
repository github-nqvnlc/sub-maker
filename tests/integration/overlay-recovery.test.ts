import { mkdir, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '@/lib/db';
import { overlayJobs, systemSettings } from '@/lib/db/schema';
import { headObject, putObject } from '@/lib/storage/client';
import { storageKeys } from '@/lib/storage/keys';
import { cleanupStaleTempDirs, runRenderOverlay } from '@/worker/jobs/render-overlay';
import { spawnRender } from '@/worker/render/spawn-render';
import { sweepStaleOverlayJobs } from '@/worker/sweeper';
import { stopBoss } from '@/worker/queues';
import { clearRateLimits, createUser, resetDb, type TestUser } from './helpers';
import { FAST_RENDER, fakeRender } from './overlay-fake-render';
import { createOverlayJob, makeVoice, overlayLogKeys, overlayRow, uploadSrt, usedBytes } from './overlay-helpers';
import { newProject } from './voice-helpers';

/** Phục hồi sau gián đoạn, dừng, treo (spec 005, FR-036, FR-037, FR-042, T031). */
let user: TestUser;
let projectId: string;
let fileId: string;
let voiceId: string;

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
  user = await createUser();
  projectId = await newProject(user);
  fileId = await uploadSrt(user, projectId);
  voiceId = (await makeVoice(user, projectId, fileId)).voiceId;
});

const newJob = () => createOverlayJob(user, projectId, { fileId, voiceId });
const stale = (id: string, over: Partial<typeof overlayJobs.$inferInsert> = {}) =>
  getDb()
    .update(overlayJobs)
    .set({ status: 'running', attempt: 1, heartbeatAt: new Date(Date.now() - 120_000), ...over })
    .where(eq(overlayJobs.id, id));
const stop = (id: string) => user.client.post(`/api/overlay/jobs/${id}/stop`, { json: {} });

describe('gián đoạn', () => {
  it('mất nhịp tim → interrupted → xếp lại → hoàn tất; nhật ký ghi rõ', async () => {
    const job = await newJob();
    await stale(job.id);
    const requeued: string[] = [];
    const r = await sweepStaleOverlayJobs({ requeue: async (id) => requeued.push(id) });
    expect(r).toEqual({ interrupted: [job.id], stopped: [], failed: [] });
    expect(requeued).toEqual([job.id]);
    expect(await overlayRow(job.id)).toMatchObject({ status: 'interrupted', interruptions: 1 });
    await runRenderOverlay(job.id, { ...FAST_RENDER, spawnRender: fakeRender().spawn });
    expect(await overlayRow(job.id)).toMatchObject({ status: 'completed', progressPercent: 100 });
    expect(await overlayLogKeys(job.id)).toEqual(expect.arrayContaining(['interrupted', 'resumed', 'completed']));
  });

  it('tiến trình còn nhịp tim không bị đụng tới', async () => {
    const job = await newJob();
    await stale(job.id, { heartbeatAt: new Date() });
    expect(await sweepStaleOverlayJobs({ requeue: async () => undefined })).toEqual({ interrupted: [], stopped: [], failed: [] });
  });

  it('gián đoạn quá 3 lần → failed RENDER_CRASHED, video dở bị xóa; chạy lại thì đếm lại từ đầu', async () => {
    const job = await newJob();
    for (let k = 1; k <= 3; k++) {
      await stale(job.id, { interruptions: k - 1 });
      expect((await sweepStaleOverlayJobs({ requeue: async () => undefined })).interrupted).toEqual([job.id]);
    }
    await putObject(storageKeys.overlayVideo(user.id, job.id, 'mp4'), Buffer.alloc(10), 'video/mp4');
    await stale(job.id);
    expect((await sweepStaleOverlayJobs({ requeue: async () => undefined })).failed).toEqual([job.id]);
    expect(await overlayRow(job.id)).toMatchObject({ status: 'failed', errorCode: 'RENDER_CRASHED' });
    expect(await headObject(storageKeys.overlayVideo(user.id, job.id, 'mp4'))).toBeNull();

    expect((await user.client.post(`/api/overlay/jobs/${job.id}/rerun`, { json: {} })).status).toBe(200);
    await stale(job.id);
    expect((await sweepStaleOverlayJobs({ requeue: async () => undefined })).interrupted).toEqual([job.id]);
    await runRenderOverlay(job.id, { ...FAST_RENDER, spawnRender: fakeRender().spawn });
    expect((await overlayRow(job.id))!.status).toBe('completed');
  });

  it('người dùng đã yêu cầu dừng mà worker chết → stopped, không chạy lại', async () => {
    const job = await newJob();
    await stale(job.id, { cancelRequested: true });
    expect(await sweepStaleOverlayJobs({ requeue: async () => undefined })).toEqual({ interrupted: [], stopped: [job.id], failed: [] });
    expect(await overlayRow(job.id)).toMatchObject({ status: 'stopped', cancelRequested: false });
  });

  it('lượt chạy cũ bị treo rồi sống lại không phá kết quả của lượt mới', async () => {
    const job = await newJob();
    const before = await usedBytes(user.id);
    const slow = fakeRender({ hold: true, bytes: 1111 });
    const old = runRenderOverlay(job.id, { ...FAST_RENDER, heartbeatMs: 60_000, spawnRender: slow.spawn });
    await slow.started;
    await stale(job.id, { attempt: 1 });
    await sweepStaleOverlayJobs({ requeue: async () => undefined });
    await runRenderOverlay(job.id, { ...FAST_RENDER, spawnRender: fakeRender({ bytes: 2222 }).spawn });
    expect(await overlayRow(job.id)).toMatchObject({ status: 'completed', outputSizeBytes: 2222 });
    slow.release();
    await old;
    expect(await overlayRow(job.id)).toMatchObject({ status: 'completed', outputSizeBytes: 2222 });
    expect(await usedBytes(user.id)).toBe(before + 2222);
  });

  it('thư mục tạm của lần chạy trước được dọn khi worker khởi động, thư mục của tiến trình còn sống được giữ', async () => {
    const dead = path.join(os.tmpdir(), 'submaker-overlay-999999-abc');
    const alive = path.join(os.tmpdir(), `submaker-overlay-${process.ppid}-abc`);
    await mkdir(dead, { recursive: true });
    await mkdir(alive, { recursive: true });
    await cleanupStaleTempDirs();
    const names = await readdir(os.tmpdir());
    expect(names).not.toContain(path.basename(dead));
    expect(names).toContain(path.basename(alive));
    const { rm } = await import('node:fs/promises');
    await rm(alive, { recursive: true, force: true });
  });
});

describe('dừng', () => {
  it('dừng khi đang chờ hoặc bị gián đoạn: dừng ngay, worker không nhận nữa', async () => {
    for (const status of ['queued', 'interrupted'] as const) {
      const job = await newJob();
      await getDb().update(overlayJobs).set({ status }).where(eq(overlayJobs.id, job.id));
      expect(await (await stop(job.id)).json()).toEqual({ status: 'stopped' });
      const fake = fakeRender();
      await runRenderOverlay(job.id, { ...FAST_RENDER, spawnRender: fake.spawn });
      expect(fake.calls).toBe(0);
      expect((await overlayRow(job.id))!.status).toBe('stopped');
    }
  });

  it('dừng khi đang chạy: tiến trình con bị hủy, không để lại video tải được, hạn mức không đổi', async () => {
    const before = await usedBytes(user.id);
    const job = await newJob();
    const fake = fakeRender({ hold: true });
    const running = runRenderOverlay(job.id, { ...FAST_RENDER, spawnRender: fake.spawn });
    await fake.started;
    expect(await (await stop(job.id)).json()).toEqual({ status: 'stopping' });
    await running;
    expect(fake.cancelled).toBeGreaterThan(0);
    expect(await overlayRow(job.id)).toMatchObject({ status: 'stopped', cancelRequested: false, outputStorageKey: null });
    expect((await user.client.get(`/api/overlay/jobs/${job.id}/video`)).status).toBe(404);
    expect(await headObject(storageKeys.overlayVideo(user.id, job.id, 'mp4'))).toBeNull();
    expect(await usedBytes(user.id)).toBe(before);
    expect(await overlayLogKeys(job.id)).toEqual(expect.arrayContaining(['stopRequested', 'stopped']));
  });

  it('dừng tiến trình con thật: thoát nhanh, không để lại ffmpeg ghi tiếp', async () => {
    const job = await newJob();
    const running = runRenderOverlay(job.id, { ...FAST_RENDER, heartbeatMs: 100 });
    for (let k = 0; k < 100 && (await overlayRow(job.id))!.progressPercent === 0; k++) await new Promise((r) => setTimeout(r, 50));
    const t0 = Date.now();
    await stop(job.id);
    await running;
    expect(Date.now() - t0).toBeLessThan(8000);
    expect((await overlayRow(job.id))!.status).toBe('stopped');
  }, 60_000);
});

describe('tiến độ và treo', () => {
  it('tiến độ được ghi trong lúc chạy (dưới 2 giây)', async () => {
    const job = await newJob();
    const fake = fakeRender({ hold: true });
    const running = runRenderOverlay(job.id, { ...FAST_RENDER, spawnRender: fake.spawn });
    await fake.started;
    await new Promise((r) => setTimeout(r, 300));
    const d = (await (await user.client.get(`/api/overlay/jobs/${job.id}`)).json()) as { status: string; progressPercent: number };
    expect(d).toMatchObject({ status: 'running', progressPercent: 47 });
    fake.release();
    await running;
    expect((await overlayRow(job.id))!.progressPercent).toBe(100);
  });

  it('không có tiến triển → RENDER_STALLED, được thử lại rồi mới báo lỗi', async () => {
    const job = await newJob();
    const fake = fakeRender({ outcomes: ['RENDER_STALLED', 'RENDER_STALLED', 'RENDER_STALLED', 'RENDER_STALLED'] });
    await runRenderOverlay(job.id, { ...FAST_RENDER, spawnRender: fake.spawn });
    expect(fake.calls).toBe(4);
    expect(await overlayRow(job.id)).toMatchObject({ status: 'failed', errorCode: 'RENDER_STALLED' });
  });

  it('spawnRender phát hiện tiến trình con thật bị treo', async () => {
    const job = await newJob();
    const row = (await overlayRow(job.id))!;
    // stallMs cực ngắn: tiến trình con chưa kịp báo khung nào đã quá hạn
    const h = spawnRender(
      { type: 'render', cues: row.cues, config: row.config, durationMs: row.durationMs, audioPath: null, outPath: path.join(os.tmpdir(), `stall-${job.id}.mp4`), maxBytes: 1e9, threads: 1, fontDir: path.resolve('public/fonts/overlay') },
      {},
      { stallMs: 1 },
    );
    expect(await h.done).toMatchObject({ ok: false, code: 'RENDER_STALLED' });
  }, 30_000);
});
