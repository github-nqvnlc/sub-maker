import { and, eq, inArray, notInArray, sql } from 'drizzle-orm';
import { getDb } from '../db';
import { audioCache, jobSegments } from '../db/schema';
import { deleteObject } from './client';
import { releaseBytes } from './quota';

/**
 * Dọn dẹp lưu trữ khi xóa tiến trình/Project (FR-004, FR-023): không để lại đối tượng mồ côi và luôn trả lại dung lượng.
 * Cache audio dùng chung giữa các tiến trình của một User nên CHỈ xóa mục không còn được `job_segments` nào tham chiếu
 * (xác định trên tập ứng viên lấy TRƯỚC khi xóa, để không đụng cache vừa được tiến trình khác ghi).
 */

export type StoredObject = { key: string; size: number };

/** Id các mục cache mà các tiến trình này đang tham chiếu (lấy trước khi xóa). */
export async function cacheIdsReferencedByJobs(jobIds: string[]): Promise<string[]> {
  if (jobIds.length === 0) return [];
  const rows = await getDb()
    .select({ id: jobSegments.audioCacheId })
    .from(jobSegments)
    .where(and(inArray(jobSegments.jobId, jobIds), sql`${jobSegments.audioCacheId} is not null`));
  return [...new Set(rows.map((r) => r.id!).filter(Boolean))];
}

/** Xóa các mục cache ứng viên KHÔNG còn được tiến trình nào tham chiếu; trả số byte đã giải phóng. */
export async function purgeOrphanCache(ownerId: string, candidateIds: string[]): Promise<number> {
  if (candidateIds.length === 0) return 0;
  const db = getDb();
  const stillUsed = await db
    .select({ id: jobSegments.audioCacheId })
    .from(jobSegments)
    .where(inArray(jobSegments.audioCacheId, candidateIds));
  const usedSet = new Set(stillUsed.map((r) => r.id));
  const orphanIds = candidateIds.filter((id) => !usedSet.has(id));
  if (orphanIds.length === 0) return 0;

  const rows = await db
    .delete(audioCache)
    .where(and(eq(audioCache.ownerId, ownerId), inArray(audioCache.id, orphanIds), notInArray(audioCache.id, stillUsed.map((r) => r.id).filter((x): x is string => !!x).concat(['00000000-0000-0000-0000-000000000000']))))
    .returning({ key: audioCache.storageKey, size: audioCache.sizeBytes });
  let freed = 0;
  for (const r of rows) {
    await deleteObject(r.key).catch(() => undefined);
    freed += r.size;
  }
  await releaseBytes(ownerId, freed);
  return freed;
}

/** Xóa các đối tượng và trả lại dung lượng tương ứng (lỗi xóa từng đối tượng không chặn các đối tượng khác). */
export async function purgeObjects(ownerId: string, objects: StoredObject[]): Promise<number> {
  let freed = 0;
  for (const o of objects) {
    try {
      await deleteObject(o.key);
    } catch {
      /* đối tượng có thể đã mất; vẫn trả dung lượng vì bản ghi đã bị xóa */
    }
    freed += o.size;
  }
  await releaseBytes(ownerId, freed);
  return freed;
}
