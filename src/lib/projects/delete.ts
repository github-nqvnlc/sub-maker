import { and, eq, inArray } from 'drizzle-orm';
import { getDb } from '../db';
import { isUuid } from './access';
import { projects, subtitleFiles, voiceJobs, voices } from '../db/schema';
import { requestStop } from '../jobs/control';
import { waitUntilNotRunning } from '../jobs/delete';
import { cacheIdsReferencedByJobs, purgeObjects, purgeOrphanCache } from '../storage/cleanup';
import { collectOverlayCleanup, runOverlayCleanup, stopProjectOverlay } from '../overlay/cleanup';
import { collectSttCleanup, runSttCleanup } from '../stt/cleanup';

/**
 * Xóa Project và TOÀN BỘ dữ liệu liên quan (FR-004): dừng tiến trình đang chạy trước, rồi xóa file gốc, voice,
 * cache không còn dùng, bản ghi (cascade) và trả lại dung lượng. Không để lại dữ liệu mồ côi.
 */
export type DeleteProjectsResult = { deleted: string[]; notFound: string[]; busy: string[] };

export async function deleteProjects(ownerId: string, ids: string[], opts: { waitMs?: number } = {}): Promise<DeleteProjectsResult> {
  const db = getDb();
  const result: DeleteProjectsResult = { deleted: [], notFound: [], busy: [] };
  // id sai định dạng coi như không tồn tại (tránh lỗi truy vấn → 500)
  const valid = ids.filter(isUuid);
  const owned = valid.length
    ? await db.select({ id: projects.id }).from(projects).where(and(eq(projects.ownerId, ownerId), inArray(projects.id, valid)))
    : [];
  const ownedIds = new Set(owned.map((p) => p.id));
  result.notFound = ids.filter((id) => !ownedIds.has(id));

  for (const projectId of ownedIds) {
    // 1) Dừng tiến trình đang chờ/chạy của Project và chờ dừng hẳn
    const jobs = await db.select({ id: voiceJobs.id }).from(voiceJobs).where(eq(voiceJobs.projectId, projectId));
    const jobIds = jobs.map((j) => j.id);
    await requestStop(ownerId, jobIds);
    const stillRunning = await waitUntilNotRunning(jobIds, opts.waitMs);
    const overlayRunning = await stopProjectOverlay(ownerId, projectId, opts.waitMs);
    if (stillRunning.length > 0 || overlayRunning.length > 0) {
      result.busy.push(projectId); // chưa dừng kịp: không xóa (tránh để lại đối tượng mồ côi)
      continue;
    }

    // 2) Thu thập mọi thứ cần dọn TRƯỚC khi xóa bản ghi
    const files = await db.select({ key: subtitleFiles.storageKey, size: subtitleFiles.sizeBytes }).from(subtitleFiles).where(eq(subtitleFiles.projectId, projectId));
    const vs = await db.select({ key: voices.storageKey, size: voices.sizeBytes }).from(voices).where(eq(voices.projectId, projectId));
    const candidates = await cacheIdsReferencedByJobs(jobIds);
    // STT job (spec 004, FR-021): file media tạm + dữ liệu trên Soniox; worker đang chạy tự dừng khi thấy job đã mất
    const sttItems = await collectSttCleanup({ projectId });
    // Video overlay (spec 005, FR-047)
    const overlayItems = await collectOverlayCleanup(ownerId, projectId);

    // 3) Xóa bản ghi (cascade: file, đoạn, tiến trình, log, voice)
    await db.delete(projects).where(and(eq(projects.id, projectId), eq(projects.ownerId, ownerId)));

    // 4) Dọn đối tượng lưu trữ và trả dung lượng
    await purgeObjects(ownerId, [...files, ...vs]);
    await purgeOrphanCache(ownerId, candidates);
    await runSttCleanup(sttItems);
    await runOverlayCleanup(ownerId, overlayItems);
    result.deleted.push(projectId);
  }
  return result;
}
