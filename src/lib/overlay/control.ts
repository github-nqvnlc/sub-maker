import { and, eq, inArray } from 'drizzle-orm';
import { getDb } from '../db';
import { OVERLAY_ACTIVE_STATUSES, overlayJobs } from '../db/schema';
import { deleteObject } from '../storage/client';
import { storageKeys } from '../storage/keys';
import { appendOverlayLog } from './log';

/**
 * Dừng tiến trình xuất video (FR-042). Đang chờ/gián đoạn → `stopped` ngay; đang chạy → cờ hủy, worker dừng tiến trình con.
 * Chỉ phụ thuộc CSDL và kho đối tượng để dùng chung cho API, khóa/xóa User và xóa Project.
 */

export type OverlayStopResult = { stopped: string[]; stopRequested: string[]; untouched: string[] };

/** Khóa đối tượng video là cố định theo id: mọi kết thúc khác `completed` đều xóa đối tượng ở khóa này (research R11). */
export async function deleteOverlayObject(job: { id: string; ownerId: string; format: string }): Promise<void> {
  await deleteObject(storageKeys.overlayVideo(job.ownerId, job.id, job.format)).catch(() => undefined);
}

export async function requestStopOverlay(ownerId: string, jobIds: string[]): Promise<OverlayStopResult> {
  const result: OverlayStopResult = { stopped: [], stopRequested: [], untouched: [] };
  if (jobIds.length === 0) return result;
  const db = getDb();
  const stopped = await db
    .update(overlayJobs)
    .set({ status: 'stopped', cancelRequested: false, finishedAt: new Date() })
    .where(and(eq(overlayJobs.ownerId, ownerId), inArray(overlayJobs.id, jobIds), inArray(overlayJobs.status, ['queued', 'interrupted'])))
    .returning({ id: overlayJobs.id, ownerId: overlayJobs.ownerId, format: overlayJobs.format });
  for (const j of stopped) {
    result.stopped.push(j.id);
    await deleteOverlayObject(j);
    await appendOverlayLog(j.id, 'warn', 'stopped');
  }
  const requested = await db
    .update(overlayJobs)
    .set({ cancelRequested: true })
    .where(and(eq(overlayJobs.ownerId, ownerId), inArray(overlayJobs.id, jobIds), eq(overlayJobs.status, 'running')))
    .returning({ id: overlayJobs.id });
  for (const j of requested) {
    result.stopRequested.push(j.id);
    await appendOverlayLog(j.id, 'warn', 'stopRequested');
  }
  const handled = new Set([...result.stopped, ...result.stopRequested]);
  result.untouched = jobIds.filter((id) => !handled.has(id));
  return result;
}

/** Dừng mọi tiến trình xuất đang hoạt động của một User (khóa hoặc xóa User). */
export async function stopAllOverlayForUser(ownerId: string): Promise<OverlayStopResult> {
  const rows = await getDb()
    .select({ id: overlayJobs.id })
    .from(overlayJobs)
    .where(and(eq(overlayJobs.ownerId, ownerId), inArray(overlayJobs.status, [...OVERLAY_ACTIVE_STATUSES])));
  return requestStopOverlay(
    ownerId,
    rows.map((r) => r.id),
  );
}

/** Chờ các tiến trình thôi ở trạng thái `running`; trả danh sách còn chạy sau khi hết giờ. */
export async function waitOverlayNotRunning(jobIds: string[], timeoutMs = 20_000): Promise<string[]> {
  if (jobIds.length === 0) return [];
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await getDb()
      .select({ id: overlayJobs.id })
      .from(overlayJobs)
      .where(and(inArray(overlayJobs.id, jobIds), eq(overlayJobs.status, 'running')));
    if (rows.length === 0 || Date.now() >= deadline) return rows.map((r) => r.id);
    await new Promise((r) => setTimeout(r, 150));
  }
}
