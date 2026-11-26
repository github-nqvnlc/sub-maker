import { and, eq, inArray, isNotNull, notInArray, sql } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import { getDb } from '../../lib/db';
import {
  OVERLAY_ACTIVE_STATUSES,
  overlayAudios,
  overlayJobs,
  STT_ACTIVE_STATUSES,
  sttJobs,
  users,
  VIDEO_EXPORT_ACTIVE,
  VIDEO_PIPELINE_ACTIVE,
  videoExports,
  videoJobs,
  videoUploads,
  voiceJobs,
} from '../../lib/db/schema';
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
 * Dịch video (spec 006, research R12): hạn mức 500 MB không tính tệp dưới `video/` và `video-tmp/` nhưng tính chữ phụ đề lưu trong
 * CSDL (`script_bytes`); bộ đếm video đối soát riêng theo bản ghi (video nguồn còn giữ + thành phẩm còn giữ).
 */
type Correction = { userId: string; before: number; after: number };
export type ReconcileResult = { checked: number; skippedBusy: number; corrected: Correction[]; videoCorrected: Correction[] };

/** Dung lượng video của User theo bản ghi: nguồn còn khóa và bản xuất còn khóa. */
async function videoBytesOf(userId: string): Promise<number> {
  const db = getDb();
  const [source] = await db
    .select({ n: sql<string>`coalesce(sum(${videoJobs.fileSizeBytes}), 0)` })
    .from(videoJobs)
    .where(and(eq(videoJobs.ownerId, userId), isNotNull(videoJobs.sourceKey)));
  const [outputs] = await db
    .select({ n: sql<string>`coalesce(sum(${videoExports.outputBytes}), 0)` })
    .from(videoExports)
    .where(and(eq(videoExports.ownerId, userId), isNotNull(videoExports.outputKey)));
  return Number(source?.n ?? 0) + Number(outputs?.n ?? 0);
}

async function scriptBytesOf(userId: string): Promise<number> {
  const [r] = await getDb()
    .select({ n: sql<string>`coalesce(sum(${videoJobs.scriptBytes}), 0)` })
    .from(videoJobs)
    .where(eq(videoJobs.ownerId, userId));
  return Number(r?.n ?? 0);
}

export async function reconcileStorage(): Promise<ReconcileResult> {
  const db = getDb();
  const all = await db
    .select({ id: users.id, used: users.storageUsedBytes, videoUsed: users.videoUsedBytes })
    .from(users)
    .where(notInArray(users.status, ['deleting']));
  const busyRows = all.length
    ? await db
        .selectDistinct({ id: voiceJobs.ownerId })
        .from(voiceJobs)
        .where(and(inArray(voiceJobs.status, ['queued', 'running']), inArray(voiceJobs.ownerId, all.map((u) => u.id))))
    : [];
  // STT job đang chờ/chạy cũng đang ghi đối tượng (file media tạm) → bỏ qua User đó
  const sttBusy = all.length
    ? await db.selectDistinct({ id: sttJobs.ownerId }).from(sttJobs).where(and(inArray(sttJobs.status, [...STT_ACTIVE_STATUSES]), inArray(sttJobs.ownerId, all.map((u) => u.id))))
    : [];
  // Video overlay (spec 005): tiến trình xuất đang hoạt động hoặc âm thanh đang xử lý cũng đang ghi đối tượng
  const ids = all.map((u) => u.id);
  const overlayBusy = all.length
    ? await db.selectDistinct({ id: overlayJobs.ownerId }).from(overlayJobs).where(and(inArray(overlayJobs.status, [...OVERLAY_ACTIVE_STATUSES]), inArray(overlayJobs.ownerId, ids)))
    : [];
  const audioBusy = all.length
    ? await db.selectDistinct({ id: overlayAudios.ownerId }).from(overlayAudios).where(and(eq(overlayAudios.status, 'processing'), inArray(overlayAudios.ownerId, ids)))
    : [];
  // Dịch video (spec 006): đang tải lên, đang dịch hoặc đang xuất thì cả hai bộ đếm đang thay đổi
  const videoBusy = all.length
    ? await db.selectDistinct({ id: videoJobs.ownerId }).from(videoJobs).where(and(inArray(videoJobs.status, [...VIDEO_PIPELINE_ACTIVE]), inArray(videoJobs.ownerId, ids)))
    : [];
  const uploadBusy = all.length
    ? await db.selectDistinct({ id: videoUploads.ownerId }).from(videoUploads).where(and(inArray(videoUploads.state, ['active', 'completing']), inArray(videoUploads.ownerId, ids)))
    : [];
  const exportBusy = all.length
    ? await db.selectDistinct({ id: videoExports.ownerId }).from(videoExports).where(and(inArray(videoExports.status, [...VIDEO_EXPORT_ACTIVE]), inArray(videoExports.ownerId, ids)))
    : [];
  const busy = new Set([...busyRows, ...sttBusy, ...overlayBusy, ...audioBusy, ...videoBusy, ...uploadBusy, ...exportBusy].map((r) => r.id));

  const result: ReconcileResult = { checked: 0, skippedBusy: 0, corrected: [], videoCorrected: [] };
  for (const u of all) {
    if (busy.has(u.id)) {
      result.skippedBusy++;
      continue;
    }
    result.checked++;
    // Không tính vào hạn mức 500 MB: media tạm của STT (spec 004), âm thanh tạm của overlay (spec 005), mọi tệp video (spec 006).
    // Chữ phụ đề của dịch video nằm trong CSDL nên cộng thêm.
    const actual =
      (await sizeByPrefix(storageKeys.userPrefix(u.id))) -
      (await sizeByPrefix(`${storageKeys.userPrefix(u.id)}stt-tmp/`)) -
      (await sizeByPrefix(storageKeys.overlayTempPrefix(u.id))) -
      (await sizeByPrefix(storageKeys.videoPrefix(u.id))) -
      (await sizeByPrefix(storageKeys.videoTempPrefix(u.id))) +
      (await scriptBytesOf(u.id));
    if (actual !== u.used) {
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
    const video = await videoBytesOf(u.id);
    if (video !== u.videoUsed) {
      const updated = await db
        .update(users)
        .set({ videoUsedBytes: video })
        .where(and(eq(users.id, u.id), sql`${users.videoUsedBytes} = ${u.videoUsed}`))
        .returning({ id: users.id });
      if (updated.length > 0) {
        result.videoCorrected.push({ userId: u.id, before: u.videoUsed, after: video });
        console.warn(`[reconcile-storage] user ${u.id}: bộ đếm video ${u.videoUsed} → ${video} (lệch ${video - u.videoUsed} byte)`);
      }
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
