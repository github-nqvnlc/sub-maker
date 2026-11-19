import { and, eq, inArray, notInArray, sql } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import { getDb } from '../../lib/db';
import { users, voiceJobs } from '../../lib/db/schema';
import { sizeByPrefix } from '../../lib/storage/client';
import { storageKeys } from '../../lib/storage/keys';
import { QUEUES, type ReconcileStoragePayload } from '../queues';

/**
 * Đối soát định kỳ `users.storage_used_bytes` với tổng dung lượng thực trong MinIO (data-model R16).
 * Bộ đếm được cập nhật nguyên tử theo từng thao tác nên chỉ lệch khi có sự cố giữa chừng (crash giữa lúc
 * ghi đối tượng và cập nhật bộ đếm). Quy tắc an toàn:
 *  - bỏ qua User đang có tiến trình chờ/chạy (đối tượng đang được ghi, số liệu tạm thời lệch là bình thường);
 *  - chỉ sửa khi bộ đếm vẫn bằng giá trị đã đọc (không đè lên cập nhật xen giữa);
 *  - ghi log mọi chênh lệch (không có nội dung nhạy cảm: chỉ id và số byte).
 */
export type ReconcileResult = { checked: number; skippedBusy: number; corrected: { userId: string; before: number; after: number }[] };

export async function reconcileStorage(): Promise<ReconcileResult> {
  const db = getDb();
  const all = await db
    .select({ id: users.id, used: users.storageUsedBytes })
    .from(users)
    .where(notInArray(users.status, ['deleting']));
  const busyRows = all.length
    ? await db
        .selectDistinct({ id: voiceJobs.ownerId })
        .from(voiceJobs)
        .where(and(inArray(voiceJobs.status, ['queued', 'running']), inArray(voiceJobs.ownerId, all.map((u) => u.id))))
    : [];
  const busy = new Set(busyRows.map((r) => r.id));

  const result: ReconcileResult = { checked: 0, skippedBusy: 0, corrected: [] };
  for (const u of all) {
    if (busy.has(u.id)) {
      result.skippedBusy++;
      continue;
    }
    result.checked++;
    const actual = await sizeByPrefix(storageKeys.userPrefix(u.id));
    if (actual === u.used) continue;
    const updated = await db
      .update(users)
      .set({ storageUsedBytes: actual })
      .where(and(eq(users.id, u.id), sql`${users.storageUsedBytes} = ${u.used}`))
      .returning({ id: users.id });
    if (updated.length > 0) {
      result.corrected.push({ userId: u.id, before: u.used, after: actual });
      console.warn(`[reconcile-storage] user ${u.id}: bộ đếm ${u.used} → thực tế ${actual} (lệch ${actual - u.used} byte)`);
    }
  }
  console.log(`[reconcile-storage] đã kiểm ${result.checked} User, bỏ qua ${result.skippedBusy} (đang bận), sửa ${result.corrected.length}`);
  return result;
}

/** Chạy hằng ngày lúc 03:17 (giờ máy chủ) — lệch khỏi giờ tròn để tránh trùng các việc định kỳ khác. */
const CRON = '17 3 * * *';

export async function registerReconcileStorage(boss: PgBoss): Promise<void> {
  await boss.work<ReconcileStoragePayload>(QUEUES.reconcileStorage, { localConcurrency: 1 }, async () => {
    await reconcileStorage();
  });
  await boss.schedule(QUEUES.reconcileStorage, CRON, {});
}
