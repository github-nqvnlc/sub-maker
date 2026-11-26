import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '@/lib/db';
import { users, videoExports, videoJobs, voiceJobs } from '@/lib/db/schema';
import { putObject } from '@/lib/storage/client';
import { storageKeys } from '@/lib/storage/keys';
import { reconcileStorage } from '@/worker/jobs/reconcile-storage';
import { stopBoss } from '@/worker/queues';
import { clearRateLimits, createUser, resetDb } from './helpers';
import { insertExport, insertUpload, insertVideoJob, videoUsed } from './video-helpers';
import { newProject, uploadScript } from './voice-helpers';

/** T150: bộ đếm dung lượng được đối soát với MinIO; User đang bận không bị đụng tới. */
beforeAll(async () => {
  await resetDb();
});
beforeEach(clearRateLimits);
afterAll(async () => {
  await stopBoss();
});

const used = async (id: string) => (await getDb().select({ u: users.storageUsedBytes }).from(users).where(eq(users.id, id)))[0]!.u;

describe('đối soát dung lượng', () => {
  it('bộ đếm đúng thì không sửa; lệch (đối tượng mồ côi / bộ đếm mất) thì sửa về giá trị thực', async () => {
    const u = await createUser();
    const projectId = await newProject(u);
    await uploadScript(u, projectId, 'Xin chào các bạn.\nHẹn gặp lại.');
    const exact = await used(u.id);
    expect(exact).toBeGreaterThan(0);

    const r1 = await reconcileStorage();
    expect(r1.corrected.filter((c) => c.userId === u.id)).toEqual([]);
    expect(await used(u.id)).toBe(exact);

    // Mô phỏng sự cố: ghi đối tượng nhưng chưa kịp cộng bộ đếm
    await putObject(storageKeys.audioCache(u.id, 'orphan'), Buffer.alloc(1234), 'audio/wav');
    const r2 = await reconcileStorage();
    expect(r2.corrected).toContainEqual({ userId: u.id, before: exact, after: exact + 1234 });
    expect(await used(u.id)).toBe(exact + 1234);

    // Mô phỏng bộ đếm bị mất/âm lệch
    await getDb().update(users).set({ storageUsedBytes: 0 }).where(eq(users.id, u.id));
    await reconcileStorage();
    expect(await used(u.id)).toBe(exact + 1234);
  });

  it('dịch video (spec 006): hạn mức 500 MB loại video/ và video-tmp/, cộng chữ phụ đề; bộ đếm video đối soát riêng', async () => {
    const u = await createUser();
    const projectId = await newProject(u);
    await uploadScript(u, projectId, 'Xin chào.');
    const base = await used(u.id);
    const job = await insertVideoJob(u.id, projectId, { status: 'review_ready', sourceState: 'ready', scriptBytes: 321, fileSizeBytes: 5000 });
    const key = storageKeys.videoSource(u.id, job.id, 'mp4');
    await getDb().update(videoJobs).set({ sourceKey: key }).where(eq(videoJobs.id, job.id));
    await putObject(key, Buffer.alloc(5000));
    const out = storageKeys.videoExport(u.id, job.id, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'mp4');
    await putObject(out, Buffer.alloc(700));
    await insertExport(job.id, u.id, { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', status: 'completed', outputKey: out, outputBytes: 700, expiresAt: new Date() });
    await putObject(storageKeys.videoAudio(u.id, job.id), Buffer.alloc(60));
    await putObject(storageKeys.videoPreview(u.id, job.id), Buffer.alloc(80));
    // đối tượng mồ côi dưới video/ (không có bản ghi): không tính vào bộ đếm video
    await putObject(storageKeys.videoSource(u.id, '00000000-0000-4000-8000-000000000000', 'mp4'), Buffer.alloc(11));
    await getDb().update(users).set({ videoUsedBytes: 999_999 }).where(eq(users.id, u.id));

    const r = await reconcileStorage();
    expect(await used(u.id)).toBe(base + 321);
    expect(await videoUsed(u.id)).toBe(5700);
    expect(r.videoCorrected).toContainEqual({ userId: u.id, before: 999_999, after: 5700 });

    // chạy lại: không còn gì để sửa
    const again = await reconcileStorage();
    expect(again.corrected.filter((c) => c.userId === u.id)).toEqual([]);
    expect(again.videoCorrected.filter((c) => c.userId === u.id)).toEqual([]);

    // nguồn đã xóa và bản xuất hết hạn thì không còn tính
    await getDb().update(videoJobs).set({ sourceState: 'deleted', sourceKey: null }).where(eq(videoJobs.id, job.id));
    await getDb().update(videoExports).set({ status: 'expired', outputKey: null }).where(eq(videoExports.jobId, job.id));
    await reconcileStorage();
    expect(await videoUsed(u.id)).toBe(0);
    expect(await used(u.id)).toBe(base + 321);
  });

  it('bỏ qua User có việc video đang chạy, đang tải lên hoặc đang xuất', async () => {
    const busy = [];
    for (const make of [
      async (u: { id: string }, p: string) => insertVideoJob(u.id, p, { status: 'translating' }),
      async (u: { id: string }, p: string) => insertUpload((await insertVideoJob(u.id, p)).id, u.id),
      async (u: { id: string }, p: string) => insertExport((await insertVideoJob(u.id, p, { status: 'review_ready' })).id, u.id, { status: 'running' }),
    ]) {
      const u = await createUser();
      await make(u, await newProject(u));
      await getDb().update(users).set({ storageUsedBytes: 5, videoUsedBytes: 7 }).where(eq(users.id, u.id));
      busy.push(u.id);
    }
    await reconcileStorage();
    for (const id of busy) {
      expect(await used(id)).toBe(5);
      expect(await videoUsed(id)).toBe(7);
    }
  });

  it('bỏ qua User đang có tiến trình chờ/chạy', async () => {
    const u = await createUser();
    const projectId = await newProject(u);
    const file = await uploadScript(u, projectId, 'Một câu.');
    await getDb().update(users).set({ storageUsedBytes: 5 }).where(eq(users.id, u.id));
    // không có cấu hình AI nên tạo job qua API sẽ thất bại; chèn thẳng trạng thái queued cho kịch bản này
    const [inserted] = await getDb()
      .insert(voiceJobs)
      .values({
        projectId,
        ownerId: u.id,
        subtitleFileId: file.id,
        providerType: 'fpt_marketplace',
        configScope: 'global',
        settings: { model: null, voice: 'banmai', speed: null },
        status: 'queued',
        progressTotal: 1,
      } as never)
      .returning({ id: voiceJobs.id });
    expect(inserted?.id).toBeTruthy();
    const r = await reconcileStorage();
    expect(r.skippedBusy).toBeGreaterThanOrEqual(1);
    expect(await used(u.id)).toBe(5); // không bị sửa
  });
});
