import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '@/lib/db';
import { overlayConfigs, overlayJobLogs, overlayJobs, systemSettings, users } from '@/lib/db/schema';
import { putObject } from '@/lib/storage/client';
import { storageKeys } from '@/lib/storage/keys';
import { deleteUserData, JobsStillRunningError } from '@/worker/jobs/delete-user';
import { reconcileStorage } from '@/worker/jobs/reconcile-storage';
import { runRenderOverlay } from '@/worker/jobs/render-overlay';
import { stopBoss } from '@/worker/queues';
import { clearRateLimits, createAdmin, createUser, resetDb, type TestUser } from './helpers';
import { FAST_RENDER, fakeRender } from './overlay-fake-render';
import { createOverlayJob, keysOf, makeVoice, overlayConfig, overlayRow, uploadSrt, usedBytes } from './overlay-helpers';
import { newProject } from './voice-helpers';

/** Xóa lần xuất, Project, User; khóa User; đối soát dung lượng (spec 005, FR-043, FR-047, T034). */
let admin: TestUser;
let user: TestUser;
let projectId: string;
let fileId: string;
let voiceId: string;

beforeAll(async () => {
  await resetDb();
  admin = await createAdmin();
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
const done = async (bytes = 5000) => {
  const job = await newJob();
  await runRenderOverlay(job.id, { ...FAST_RENDER, spawnRender: fakeRender({ bytes }).spawn });
  return job.id;
};

describe('xóa lần xuất', () => {
  it('xóa nhiều: mất bản ghi, nhật ký, đối tượng; trả đúng dung lượng', async () => {
    const before = await usedBytes(user.id);
    const a = await done(1000);
    const b = await done(2000);
    const keep = await done(4000);
    expect(await usedBytes(user.id)).toBe(before + 7000);
    const r = await user.client.post('/api/overlay/jobs/bulk-delete', { json: { ids: [a, b] } });
    expect(((await r.json()) as { deleted: string[] }).deleted).toHaveLength(2);
    expect(await usedBytes(user.id)).toBe(before + 4000);
    expect(await keysOf(user.id, 'overlay/')).toEqual([storageKeys.overlayVideo(user.id, keep, 'mp4')]);
    expect(await getDb().select().from(overlayJobLogs).where(eq(overlayJobLogs.jobId, a))).toEqual([]);
    expect((await user.client.get(`/api/overlay/jobs/${a}/video`)).status).toBe(404);
  });

  it('tiến trình đang chạy được dừng trước khi xóa', async () => {
    const before = await usedBytes(user.id);
    const job = await newJob();
    const fake = fakeRender({ hold: true });
    const running = runRenderOverlay(job.id, { ...FAST_RENDER, spawnRender: fake.spawn });
    await fake.started;
    const r = await user.client.post('/api/overlay/jobs/bulk-delete', { json: { ids: [job.id] } });
    expect(await r.json()).toEqual({ deleted: [job.id], busy: [], notFound: [] });
    await running;
    expect(await overlayRow(job.id)).toBeUndefined();
    expect(await keysOf(user.id, 'overlay/')).toEqual([]);
    expect(await usedBytes(user.id)).toBe(before);
  });
});

describe('xóa Project', () => {
  it('xóa sạch video, video dở, cấu hình, nhật ký; trả dung lượng', async () => {
    const start = await usedBytes(user.id);
    await user.client.put(`/api/projects/${projectId}/overlay`, { json: { config: overlayConfig(), source: {} } });
    await done(3000);
    const failed = await newJob();
    await getDb().update(overlayJobs).set({ status: 'failed', errorCode: 'RENDER_FAILED' }).where(eq(overlayJobs.id, failed.id));
    await putObject(storageKeys.overlayVideo(user.id, failed.id, 'mp4'), Buffer.alloc(77), 'video/mp4');
    expect(await usedBytes(user.id)).toBe(start + 3000);

    expect((await user.client.delete(`/api/projects/${projectId}`)).status).toBeLessThan(300);
    expect(await keysOf(user.id, 'overlay')).toEqual([]);
    expect(await usedBytes(user.id)).toBe(0);
    expect(await getDb().select().from(overlayJobs).where(eq(overlayJobs.ownerId, user.id))).toEqual([]);
    expect(await getDb().select().from(overlayConfigs).where(eq(overlayConfigs.ownerId, user.id))).toEqual([]);
  });

  it('dừng tiến trình đang chạy rồi mới xóa', async () => {
    const job = await newJob();
    const fake = fakeRender({ hold: true });
    const running = runRenderOverlay(job.id, { ...FAST_RENDER, spawnRender: fake.spawn });
    await fake.started;
    expect((await user.client.delete(`/api/projects/${projectId}`)).status).toBeLessThan(300);
    await running;
    expect(await overlayRow(job.id)).toBeUndefined();
    expect(await keysOf(user.id, 'overlay')).toEqual([]);
  });

  it('Project bị xóa thẳng khi đang xuất (bản ghi mất): worker dừng và không để lại đối tượng', async () => {
    const job = await newJob();
    const fake = fakeRender({ hold: true });
    const running = runRenderOverlay(job.id, { ...FAST_RENDER, spawnRender: fake.spawn });
    await fake.started;
    await getDb().delete(overlayJobs).where(eq(overlayJobs.id, job.id));
    await running;
    expect(fake.cancelled).toBeGreaterThan(0);
    expect(await keysOf(user.id, 'overlay')).toEqual([]);
  });
});

describe('khóa và xóa User', () => {
  it('khóa User: tiến trình đang chờ và đang chạy đều dừng, video cũ còn', async () => {
    const old = await done();
    const queued = await newJob();
    const job = await newJob();
    const fake = fakeRender({ hold: true });
    // việc tạo sau chạy được vì việc tạo trước không có người xử lý (không chạm nhịp tim)
    const running = runRenderOverlay(job.id, { ...FAST_RENDER, spawnRender: fake.spawn });
    await fake.started;
    expect((await admin.client.patch(`/api/admin/users/${user.id}`, { json: { status: 'banned' } })).status).toBe(200);
    await running;
    expect((await overlayRow(queued.id))!.status).toBe('stopped');
    expect((await overlayRow(job.id))!.status).toBe('stopped');
    expect((await overlayRow(old))!.status).toBe('completed');
  });

  it('xóa User: chờ tiến trình đang chạy dừng, rồi xóa hết đối tượng và bản ghi', async () => {
    await done();
    const job = await newJob();
    await getDb().update(overlayJobs).set({ status: 'running', heartbeatAt: new Date() }).where(eq(overlayJobs.id, job.id));
    await expect(deleteUserData(user.id)).rejects.toBeInstanceOf(JobsStillRunningError);
    expect((await overlayRow(job.id))!.cancelRequested).toBe(true);
    await getDb().update(overlayJobs).set({ status: 'stopped' }).where(eq(overlayJobs.id, job.id));
    await deleteUserData(user.id);
    expect(await keysOf(user.id)).toEqual([]);
    expect(await getDb().select().from(overlayJobs).where(eq(overlayJobs.ownerId, user.id))).toEqual([]);
  });
});

describe('đối soát dung lượng', () => {
  it('video tính vào hạn mức, tệp tạm thì không; User đang xuất được bỏ qua', async () => {
    await done(4321);
    await putObject(storageKeys.overlayAudioTemp(user.id, 'x', 'mp3'), Buffer.alloc(9999), 'audio/mpeg');
    const exact = await usedBytes(user.id);
    expect((await reconcileStorage()).corrected.filter((c) => c.userId === user.id)).toEqual([]);

    await getDb().update(users).set({ storageUsedBytes: 5 }).where(eq(users.id, user.id));
    const job = await newJob();
    await reconcileStorage();
    expect(await usedBytes(user.id)).toBe(5);
    await user.client.post('/api/overlay/jobs/bulk-delete', { json: { ids: [job.id] } });
    await reconcileStorage();
    expect(await usedBytes(user.id)).toBe(exact);
  });
});
