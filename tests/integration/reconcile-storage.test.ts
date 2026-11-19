import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getDb } from '@/lib/db';
import { users, voiceJobs } from '@/lib/db/schema';
import { putObject } from '@/lib/storage/client';
import { storageKeys } from '@/lib/storage/keys';
import { reconcileStorage } from '@/worker/jobs/reconcile-storage';
import { stopBoss } from '@/worker/queues';
import { createUser, resetDb } from './helpers';
import { newProject, uploadScript } from './voice-helpers';

/** T150: bộ đếm dung lượng được đối soát với MinIO; User đang bận không bị đụng tới. */
beforeAll(async () => {
  await resetDb();
});
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
