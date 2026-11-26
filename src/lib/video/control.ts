import { and, eq, inArray } from 'drizzle-orm';
import { getDb } from '../db';
import { VIDEO_EXPORT_ACTIVE, VIDEO_PIPELINE_ACTIVE, VIDEO_PIPELINE_RUNNING, videoExports, videoJobs } from '../db/schema';
import { recomputeSourceExpiry } from './expiry';
import { appendVideoLog } from './log';
import { providerSnapshot, releaseProviderData } from './provider-data';

/**
 * Dừng tiến trình video (spec 006, FR-045, FR-057): đang chờ hoặc bị gián đoạn → `stopped` ngay; đang chạy → cờ hủy, worker dừng ở
 * nhịp tim kế tiếp. Dùng chung cho thao tác của người dùng, thu hồi quyền, khóa/xóa User và xóa Project.
 */
export type VideoStopResult = { stopped: string[]; stopRequested: string[] };

/** Dừng pipeline dịch của các việc thuộc `ownerId`. */
export async function requestStopVideoJobs(ownerId: string, jobIds: string[]): Promise<VideoStopResult> {
  const result: VideoStopResult = { stopped: [], stopRequested: [] };
  if (jobIds.length === 0) return result;
  const db = getDb();
  const mine = and(eq(videoJobs.ownerId, ownerId), inArray(videoJobs.id, jobIds));
  await db.transaction(async (tx) => {
    const stopped = await tx
      .update(videoJobs)
      .set({ status: 'stopped', stageKey: 'stopped', cancelRequested: false, finishedAt: new Date(), updatedAt: new Date() })
      .where(and(mine, inArray(videoJobs.status, ['queued', 'interrupted'])))
      .returning({ id: videoJobs.id });
    for (const j of stopped) await recomputeSourceExpiry(j.id, tx as unknown as typeof db);
    result.stopped = stopped.map((j) => j.id);
  });
  const requested = await db
    .update(videoJobs)
    .set({ cancelRequested: true, updatedAt: new Date() })
    .where(and(mine, inArray(videoJobs.status, [...VIDEO_PIPELINE_RUNNING])))
    .returning({ id: videoJobs.id });
  result.stopRequested = requested.map((j) => j.id);
  for (const id of result.stopped) await appendVideoLog(id, 'warn', 'stopped');
  for (const id of result.stopRequested) await appendVideoLog(id, 'warn', 'stopRequested');
  // việc dừng khi không có worker giữ (đang chờ, gián đoạn) mà còn dữ liệu ở nhà cung cấp: lấy kết quả nếu có rồi xóa (FR-017)
  if (result.stopped.length > 0) {
    const rows = await db.select().from(videoJobs).where(inArray(videoJobs.id, result.stopped));
    for (const row of rows) await releaseProviderData(providerSnapshot(row)).catch(() => false);
  }
  return result;
}

/** Dừng các bản xuất thuộc `ownerId`. */
export async function requestStopVideoExports(ownerId: string, exportIds: string[]): Promise<VideoStopResult> {
  const result: VideoStopResult = { stopped: [], stopRequested: [] };
  if (exportIds.length === 0) return result;
  const db = getDb();
  const mine = and(eq(videoExports.ownerId, ownerId), inArray(videoExports.id, exportIds));
  const back = { id: videoExports.id, jobId: videoExports.jobId };
  const stopped = await db.transaction(async (tx) => {
    const rows = await tx
      .update(videoExports)
      .set({ status: 'stopped', cancelRequested: false, finishedAt: new Date() })
      .where(and(mine, inArray(videoExports.status, ['queued', 'interrupted'])))
      .returning(back);
    for (const r of rows) await recomputeSourceExpiry(r.jobId, tx as unknown as typeof db);
    return rows;
  });
  const requested = await db
    .update(videoExports)
    .set({ cancelRequested: true })
    .where(and(mine, eq(videoExports.status, 'running')))
    .returning(back);
  for (const r of stopped) await appendVideoLog(r.jobId, 'warn', 'stopped', undefined, { exportId: r.id });
  for (const r of requested) await appendVideoLog(r.jobId, 'warn', 'stopRequested', undefined, { exportId: r.id });
  result.stopped = stopped.map((r) => r.id);
  result.stopRequested = requested.map((r) => r.id);
  return result;
}

async function activeOf(ownerId: string, projectId?: string) {
  const db = getDb();
  const inProject = projectId ? eq(videoJobs.projectId, projectId) : undefined;
  const jobs = await db
    .select({ id: videoJobs.id })
    .from(videoJobs)
    .where(and(eq(videoJobs.ownerId, ownerId), inProject, inArray(videoJobs.status, [...VIDEO_PIPELINE_ACTIVE])));
  const exports = await db
    .select({ id: videoExports.id })
    .from(videoExports)
    .innerJoin(videoJobs, eq(videoJobs.id, videoExports.jobId))
    .where(and(eq(videoExports.ownerId, ownerId), inProject, inArray(videoExports.status, [...VIDEO_EXPORT_ACTIVE])));
  return { jobIds: jobs.map((j) => j.id), exportIds: exports.map((e) => e.id) };
}

/** Dừng mọi tiến trình video của một User (khóa, xóa hoặc thu hồi quyền). */
export async function stopAllVideoForUser(ownerId: string): Promise<VideoStopResult> {
  const { jobIds, exportIds } = await activeOf(ownerId);
  const a = await requestStopVideoJobs(ownerId, jobIds);
  const b = await requestStopVideoExports(ownerId, exportIds);
  return { stopped: [...a.stopped, ...b.stopped], stopRequested: [...a.stopRequested, ...b.stopRequested] };
}

/** Số tiến trình video của User (hoặc của Project) đang được worker chạy. */
export async function videoRunningCount(ownerId: string, projectId?: string): Promise<number> {
  const db = getDb();
  const inProject = projectId ? eq(videoJobs.projectId, projectId) : undefined;
  const jobs = await db
    .select({ id: videoJobs.id })
    .from(videoJobs)
    .where(and(eq(videoJobs.ownerId, ownerId), inProject, inArray(videoJobs.status, [...VIDEO_PIPELINE_RUNNING])));
  const exports = await db
    .select({ id: videoExports.id })
    .from(videoExports)
    .innerJoin(videoJobs, eq(videoJobs.id, videoExports.jobId))
    .where(and(eq(videoExports.ownerId, ownerId), inProject, eq(videoExports.status, 'running')));
  return jobs.length + exports.length;
}

/** Dừng tiến trình video của một Project rồi chờ dừng hẳn; trả số tiến trình còn chạy khi hết giờ chờ. */
export async function stopProjectVideo(ownerId: string, projectId: string, waitMs = 20_000): Promise<number> {
  const { jobIds, exportIds } = await activeOf(ownerId, projectId);
  await requestStopVideoJobs(ownerId, jobIds);
  await requestStopVideoExports(ownerId, exportIds);
  const deadline = Date.now() + waitMs;
  for (;;) {
    const running = await videoRunningCount(ownerId, projectId);
    if (running === 0 || Date.now() >= deadline) return running;
    await new Promise((r) => setTimeout(r, 150));
  }
}
