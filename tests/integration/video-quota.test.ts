import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '@/lib/db';
import { systemSettings, users, videoUploads } from '@/lib/db/schema';
import { updateSettings } from '@/lib/settings';
import {
  addVideoUsed,
  assertJobSlot,
  assertVideoRoom,
  videoActiveJobCount,
  videoQuotaInfo,
  videoReservedBytes,
  videoSystemBytes,
  withVideoLock,
} from '@/lib/video/quota';
import { stopBoss } from '@/worker/queues';
import { clearRateLimits, createUser, resetDb, type TestUser } from './helpers';
import { insertExport, insertUpload, insertVideoJob, videoUsed } from './video-helpers';
import { newProject } from './voice-helpers';

/** Hạn mức video: giữ chỗ, trần hệ thống, số việc đang chạy, đồng thời (spec 006, T010; FR-007, FR-008, FR-053, SC-015). */
const GB = 1024 ** 3;
let user: TestUser;
let other: TestUser;
let projectId: string;
let otherProject: string;

beforeAll(async () => {
  await resetDb();
}, 60_000);
afterAll(async () => {
  await stopBoss();
});
beforeEach(async () => {
  await clearRateLimits();
  await getDb().delete(systemSettings);
  await getDb().delete(users);
  user = await createUser();
  other = await createUser();
  projectId = await newProject(user);
  otherProject = await newProject(other);
});

const setUsed = (id: string, n: number) => getDb().update(users).set({ videoUsedBytes: n }).where(eq(users.id, id));
const room = (id: string, need: number) => withVideoLock((tx) => assertVideoRoom(tx, id, need));

describe('giữ chỗ suy ra từ phiên tải mở và bản xuất đang chờ/chạy', () => {
  it('chỉ tính phiên nguồn đang mở và bản xuất chờ, chạy, gián đoạn', async () => {
    const open = await insertVideoJob(user.id, projectId);
    await insertUpload(open.id, user.id, { sizeBytes: 100 });
    await insertUpload(open.id, user.id, { kind: 'client_audio', sizeBytes: 7 }); // tệp tạm: không tính
    const completing = await insertVideoJob(user.id, projectId);
    await insertUpload(completing.id, user.id, { sizeBytes: 20, state: 'completing' });
    await insertUpload(completing.id, user.id, { sizeBytes: 5000, state: 'completed' });
    await insertUpload(completing.id, user.id, { sizeBytes: 5000, state: 'aborted' });
    const exporting = await insertVideoJob(user.id, projectId, { status: 'review_ready' });
    await insertExport(exporting.id, user.id, { estimatedBytes: 3, status: 'queued' });
    const running = await insertVideoJob(user.id, projectId, { status: 'review_ready' });
    await insertExport(running.id, user.id, { estimatedBytes: 4, status: 'running' });
    await insertExport(running.id, user.id, { estimatedBytes: 900, status: 'failed' });
    const interrupted = await insertVideoJob(user.id, projectId, { status: 'review_ready' });
    await insertExport(interrupted.id, user.id, { estimatedBytes: 5, status: 'interrupted' });
    const theirs = await insertVideoJob(other.id, otherProject);
    await insertUpload(theirs.id, other.id, { sizeBytes: 11 });

    expect(await videoReservedBytes(user.id)).toBe(100 + 20 + 3 + 4 + 5);
    expect(await videoReservedBytes(other.id)).toBe(11);
  });

  it('đủ chỗ đúng bằng hạn mức thì được; hơn 1 byte thì bị chặn kèm số cần giải phóng', async () => {
    await updateSettings({ userVideoQuotaBytes: GB }, null);
    await setUsed(user.id, GB - 1000);
    const job = await insertVideoJob(user.id, projectId);
    await insertUpload(job.id, user.id, { sizeBytes: 400 });
    await expect(room(user.id, 600)).resolves.toBeUndefined();
    await expect(room(user.id, 601)).rejects.toMatchObject({ status: 409, code: 'VIDEO_QUOTA_EXCEEDED', fields: { needBytes: '1', remainingBytes: '600' } });
    expect(await videoQuotaInfo(user.id)).toEqual({ quotaBytes: GB, usedBytes: GB - 1000, reservedBytes: 400, remainingBytes: 600, activeJobs: 1, maxJobs: 1 });
  });

  it('hạ hạn mức dưới mức đang dùng: chỗ còn lại là 0, không âm', async () => {
    await updateSettings({ userVideoQuotaBytes: GB }, null);
    await setUsed(user.id, 2 * GB);
    expect((await videoQuotaInfo(user.id)).remainingBytes).toBe(0);
    await expect(room(user.id, 1)).rejects.toMatchObject({ code: 'VIDEO_QUOTA_EXCEEDED' });
  });
});

describe('trần hệ thống', () => {
  it('tổng đã dùng + đang giữ + bản xem trước của mọi User không vượt trần', async () => {
    await updateSettings({ videoSystemCapBytes: GB, userVideoQuotaBytes: 1024 * GB }, null);
    await setUsed(other.id, GB - 1000);
    const theirs = await insertVideoJob(other.id, otherProject, { previewBytes: 300 });
    await insertUpload(theirs.id, other.id, { sizeBytes: 200 });
    expect(await videoSystemBytes()).toBe(GB - 500);
    await expect(room(user.id, 500)).resolves.toBeUndefined();
    await expect(room(user.id, 501)).rejects.toMatchObject({ status: 409, code: 'VIDEO_SYSTEM_FULL' });
  });
});

describe('bộ đếm đã dùng', () => {
  it('cộng, trừ và không bao giờ âm', async () => {
    await addVideoUsed(user.id, 50);
    await addVideoUsed(user.id, -20);
    expect(await videoUsed(user.id)).toBe(30);
    await addVideoUsed(user.id, -1000);
    expect(await videoUsed(user.id)).toBe(0);
  });
});

describe('số việc đang chạy (data-model §3.2)', () => {
  it('đếm mỗi việc một lần theo phiên tải mở, pipeline hoặc bản xuất đang hoạt động', async () => {
    const counts = async () => videoActiveJobCount(user.id);
    for (const status of ['review_ready', 'failed', 'stopped', 'waiting_media'] as const) await insertVideoJob(user.id, projectId, { status });
    expect(await counts()).toBe(0);
    let expected = 0;
    for (const status of ['queued', 'preparing', 'translating', 'segmenting', 'interrupted'] as const) {
      await insertVideoJob(user.id, projectId, { status });
      expect(await counts()).toBe(++expected);
    }
    const uploading = await insertVideoJob(user.id, projectId);
    await insertUpload(uploading.id, user.id);
    await insertUpload(uploading.id, user.id, { kind: 'client_audio' });
    expect(await counts()).toBe(++expected);
    for (const status of ['queued', 'running', 'interrupted'] as const) {
      const j = await insertVideoJob(user.id, projectId, { status: 'review_ready' });
      await insertExport(j.id, user.id, { status });
      expect(await counts()).toBe(++expected);
    }
    for (const status of ['completed', 'failed', 'stopped', 'expired'] as const) {
      const j = await insertVideoJob(user.id, projectId, { status: 'review_ready' });
      await insertExport(j.id, user.id, { status, ...(status === 'completed' ? { outputKey: 'k', outputBytes: 1, expiresAt: new Date() } : {}) });
    }
    expect(await counts()).toBe(expected);
    expect(await videoActiveJobCount(user.id, { excludeJobId: uploading.id })).toBe(expected - 1);
    expect(await videoActiveJobCount(other.id)).toBe(0);
  });

  it('đủ số việc thì 429 VIDEO_TOO_MANY_JOBS; chính việc đang xét không tự chặn mình', async () => {
    const job = await insertVideoJob(user.id, projectId, { status: 'queued' });
    await expect(withVideoLock((tx) => assertJobSlot(tx, user.id))).rejects.toMatchObject({ status: 429, code: 'VIDEO_TOO_MANY_JOBS' });
    await expect(withVideoLock((tx) => assertJobSlot(tx, user.id, { excludeJobId: job.id }))).resolves.toBeUndefined();
    await updateSettings({ videoMaxJobsPerUser: 2 }, null);
    await expect(withVideoLock((tx) => assertJobSlot(tx, user.id))).resolves.toBeUndefined();
  });
});

describe('nhiều yêu cầu cùng lúc (SC-015)', () => {
  /** Một yêu cầu tạo việc: kiểm và giữ chỗ trong cùng giao dịch có khóa. */
  async function admit(owner: TestUser, project: string, size: number): Promise<boolean> {
    try {
      await withVideoLock(async (tx) => {
        await assertJobSlot(tx, owner.id);
        await assertVideoRoom(tx, owner.id, size);
        const job = await insertVideoJob(owner.id, project, {}, tx);
        await tx.insert(videoUploads).values({ jobId: job.id, ownerId: owner.id, kind: 'source', storageUploadId: 'x', key: 'k', sizeBytes: size, partSize: 1, partCount: 1, fingerprint: 'f', expiresAt: new Date() });
      });
      return true;
    } catch {
      return false;
    }
  }

  it('hạn mức mỗi người không bị vượt', async () => {
    await updateSettings({ userVideoQuotaBytes: GB, videoMaxJobsPerUser: 10 }, null);
    const size = Math.floor(GB / 3);
    const results = await Promise.all(Array.from({ length: 8 }, () => admit(user, projectId, size)));
    expect(results.filter(Boolean)).toHaveLength(3);
    expect(await videoReservedBytes(user.id)).toBeLessThanOrEqual(GB);
  });

  it('trần hệ thống không bị vượt khi nhiều người cùng gửi', async () => {
    await updateSettings({ videoSystemCapBytes: GB, userVideoQuotaBytes: GB, videoMaxJobsPerUser: 10 }, null);
    const size = Math.floor(GB / 2);
    const results = await Promise.all([admit(user, projectId, size), admit(other, otherProject, size), admit(user, projectId, size), admit(other, otherProject, size)]);
    expect(results.filter(Boolean)).toHaveLength(2);
    expect(await videoSystemBytes()).toBeLessThanOrEqual(GB);
  });

  it('giới hạn số việc không bị vượt', async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => admit(user, projectId, 10)));
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});
