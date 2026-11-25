import { and, eq, inArray } from 'drizzle-orm';
import { getDb } from '../db';
import { OVERLAY_ACTIVE_STATUSES, overlayAudios, overlayJobs } from '../db/schema';
import { deleteObject } from '../storage/client';
import { purgeObjects, type StoredObject } from '../storage/cleanup';
import { storageKeys } from '../storage/keys';
import { requestStopOverlay, waitOverlayNotRunning } from './control';

/** Dọn dữ liệu video overlay khi xóa Project (FR-047): dừng tiến trình, thu thập khóa TRƯỚC khi xóa bản ghi, rồi xóa và trả hạn mức. */

export type OverlayCleanup = {
  /** đối tượng tính vào hạn mức */
  stored: StoredObject[];
  /** đối tượng không tính vào hạn mức (video chưa hoàn tất, âm thanh tạm) */
  loose: string[];
};

/** Dừng tiến trình xuất của Project; trả id còn chạy sau khi hết giờ chờ. */
export async function stopProjectOverlay(ownerId: string, projectId: string, waitMs?: number): Promise<string[]> {
  const rows = await getDb()
    .select({ id: overlayJobs.id })
    .from(overlayJobs)
    .where(and(eq(overlayJobs.projectId, projectId), eq(overlayJobs.ownerId, ownerId), inArray(overlayJobs.status, [...OVERLAY_ACTIVE_STATUSES])));
  const ids = rows.map((r) => r.id);
  if (ids.length === 0) return [];
  await requestStopOverlay(ownerId, ids);
  return waitOverlayNotRunning(ids, waitMs);
}

export async function collectOverlayCleanup(ownerId: string, projectId: string): Promise<OverlayCleanup> {
  const db = getDb();
  const jobs = await db
    .select({ id: overlayJobs.id, format: overlayJobs.format, key: overlayJobs.outputStorageKey, size: overlayJobs.outputSizeBytes })
    .from(overlayJobs)
    .where(and(eq(overlayJobs.projectId, projectId), eq(overlayJobs.ownerId, ownerId)));
  const audios = await db
    .select({ id: overlayAudios.id, key: overlayAudios.storageKey, size: overlayAudios.sizeBytes, status: overlayAudios.status, temp: overlayAudios.tempStorageKey })
    .from(overlayAudios)
    .where(and(eq(overlayAudios.projectId, projectId), eq(overlayAudios.ownerId, ownerId)));
  const out: OverlayCleanup = { stored: [], loose: [] };
  for (const j of jobs) {
    if (j.key && j.size) out.stored.push({ key: j.key, size: j.size });
    else out.loose.push(storageKeys.overlayVideo(ownerId, j.id, j.format));
  }
  for (const a of audios) {
    if (a.status === 'ready' && a.key) out.stored.push({ key: a.key, size: a.size });
    else out.loose.push(storageKeys.overlayAudio(ownerId, a.id));
    if (a.temp) out.loose.push(a.temp);
  }
  return out;
}

export async function runOverlayCleanup(ownerId: string, c: OverlayCleanup): Promise<void> {
  for (const key of c.loose) await deleteObject(key).catch(() => undefined);
  if (c.stored.length > 0) await purgeObjects(ownerId, c.stored);
}
