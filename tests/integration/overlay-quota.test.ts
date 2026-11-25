import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '@/lib/db';
import { overlayJobs, systemSettings, users } from '@/lib/db/schema';
import { updateSettings } from '@/lib/settings';
import { headObject } from '@/lib/storage/client';
import { storageKeys } from '@/lib/storage/keys';
import { runRenderOverlay } from '@/worker/jobs/render-overlay';
import { sweepStaleOverlayJobs } from '@/worker/sweeper';
import { stopBoss } from '@/worker/queues';
import { clearRateLimits, createUser, resetDb, type TestUser } from './helpers';
import { FAST_RENDER, fakeRender } from './overlay-fake-render';
import { createOverlayJob, makeVoice, overlayRow, postOverlayJob, uploadSrt, usedBytes } from './overlay-helpers';
import { newProject } from './voice-helpers';

/** Hạn mức lưu trữ của video overlay (spec 005, FR-043, FR-044, SC-014, T029). */
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
  user = await createUser();
  projectId = await newProject(user);
  fileId = await uploadSrt(user, projectId);
  voiceId = (await makeVoice(user, projectId, fileId)).voiceId;
});

const setQuotaLeft = async (left: number) => updateSettings({ userQuotaBytes: (await usedBytes(user.id)) + left }, null);
const errorOf = async (r: Response) => ((await r.json()) as { error: { code: string; fields: Record<string, string> } }).error;

describe('chặn khi tạo', () => {
  it('ước tính vượt chỗ còn lại → 409 nêu cần thêm và còn lại; không tạo tiến trình', async () => {
    const probe = await createOverlayJob(user, projectId, { fileId, voiceId });
    await user.client.post('/api/overlay/jobs/bulk-delete', { json: { ids: [probe.id] } });
    await setQuotaLeft(probe.estimatedBytes - 1);
    const r = await postOverlayJob(user, projectId, { fileId, voiceId });
    expect(r.status).toBe(409);
    expect(await errorOf(r)).toMatchObject({ code: 'QUOTA_EXCEEDED', fields: { needBytes: '1', remainingBytes: String(probe.estimatedBytes - 1) } });
    await setQuotaLeft(probe.estimatedBytes);
    expect((await postOverlayJob(user, projectId, { fileId, voiceId })).status).toBe(201);
  });

  it('tính cả ước tính của tiến trình đang chờ; hai yêu cầu song song không cùng vượt', async () => {
    const probe = await createOverlayJob(user, projectId, { fileId, voiceId });
    await user.client.post('/api/overlay/jobs/bulk-delete', { json: { ids: [probe.id] } });
    await setQuotaLeft(Math.floor(probe.estimatedBytes * 1.5));
    const rs = await Promise.all([postOverlayJob(user, projectId, { fileId, voiceId }), postOverlayJob(user, projectId, { fileId, voiceId })]);
    expect(rs.map((r) => r.status).sort()).toEqual([201, 409]);
  });

  it('hạ hạn mức dưới mức đang dùng: video cũ vẫn tải được, tạo mới bị chặn', async () => {
    const job = await createOverlayJob(user, projectId, { fileId, voiceId });
    await runRenderOverlay(job.id, { ...FAST_RENDER, spawnRender: fakeRender().spawn });
    await updateSettings({ userQuotaBytes: 1_048_576 }, null);
    await getDb().update(users).set({ storageUsedBytes: 5_000_000 }).where(eq(users.id, user.id));
    const res = await user.client.get(`/api/overlay/jobs/${job.id}/video`);
    expect(res.status).toBe(200);
    expect((await res.arrayBuffer()).byteLength).toBe(5000);
    expect((await postOverlayJob(user, projectId, { fileId, voiceId })).status).toBe(409);
  });
});

describe('trừ và trả lại', () => {
  it('xong thì cộng đúng dung lượng thật; xóa thì trả lại đúng', async () => {
    const before = await usedBytes(user.id);
    const job = await createOverlayJob(user, projectId, { fileId, voiceId });
    expect(await usedBytes(user.id)).toBe(before);
    await runRenderOverlay(job.id, { ...FAST_RENDER, spawnRender: fakeRender({ bytes: 12_345 }).spawn });
    const row = (await overlayRow(job.id))!;
    expect(row).toMatchObject({ status: 'completed', outputSizeBytes: 12_345, outputStorageKey: storageKeys.overlayVideo(user.id, job.id, 'mp4') });
    expect(await usedBytes(user.id)).toBe(before + 12_345);
    expect((await headObject(row.outputStorageKey!))!.size).toBe(12_345);
    await user.client.post('/api/overlay/jobs/bulk-delete', { json: { ids: [job.id] } });
    expect(await usedBytes(user.id)).toBe(before);
    expect(await headObject(row.outputStorageKey!)).toBeNull();
  });

  it('video thật lớn hơn chỗ còn lại → failed QUOTA_EXCEEDED, không có đối tượng, hạn mức không đổi', async () => {
    const job = await createOverlayJob(user, projectId, { fileId, voiceId });
    await setQuotaLeft(1000);
    const before = await usedBytes(user.id);
    await runRenderOverlay(job.id, { ...FAST_RENDER, spawnRender: fakeRender({ bytes: 5000 }).spawn });
    expect(await overlayRow(job.id)).toMatchObject({ status: 'failed', errorCode: 'QUOTA_EXCEEDED', outputStorageKey: null });
    expect(await usedBytes(user.id)).toBe(before);
    expect(await headObject(storageKeys.overlayVideo(user.id, job.id, 'mp4'))).toBeNull();
  });

  it('tiến trình con dừng sớm vì vượt chỗ còn lại → failed QUOTA_EXCEEDED, không thử lại', async () => {
    const job = await createOverlayJob(user, projectId, { fileId, voiceId });
    const fake = fakeRender({ outcomes: ['QUOTA_EXCEEDED'] });
    await runRenderOverlay(job.id, { ...FAST_RENDER, spawnRender: fake.spawn });
    expect(fake.calls).toBe(1);
    expect(await overlayRow(job.id)).toMatchObject({ status: 'failed', errorCode: 'QUOTA_EXCEEDED' });
  });

  it('worker chết sau khi ghi đối tượng nhưng trước khi hoàn tất rồi chạy lại: hạn mức chỉ bị trừ một lần', async () => {
    const before = await usedBytes(user.id);
    const job = await createOverlayJob(user, projectId, { fileId, voiceId });
    // Mô phỏng: đối tượng đã ghi, worker chết (nhịp tim quá hạn), hạn mức chưa bị trừ
    const { putObject } = await import('@/lib/storage/client');
    await putObject(storageKeys.overlayVideo(user.id, job.id, 'mp4'), Buffer.alloc(9000), 'video/mp4');
    await getDb().update(overlayJobs).set({ status: 'running', attempt: 1, heartbeatAt: new Date(Date.now() - 120_000) }).where(eq(overlayJobs.id, job.id));
    const swept = await sweepStaleOverlayJobs({ requeue: async () => undefined });
    expect(swept.interrupted).toContain(job.id);
    await runRenderOverlay(job.id, { ...FAST_RENDER, spawnRender: fakeRender({ bytes: 7000 }).spawn });
    expect(await overlayRow(job.id)).toMatchObject({ status: 'completed', outputSizeBytes: 7000 });
    expect(await usedBytes(user.id)).toBe(before + 7000);
    expect((await headObject(storageKeys.overlayVideo(user.id, job.id, 'mp4')))!.size).toBe(7000);
  });
});
