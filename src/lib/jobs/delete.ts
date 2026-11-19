import { and, eq, inArray, sql } from 'drizzle-orm';
import { getDb } from '../db';
import { isUuid } from '../projects/access';
import { projects, voiceJobs, voices } from '../db/schema';
import { cacheIdsReferencedByJobs, purgeObjects, purgeOrphanCache } from '../storage/cleanup';
import { requestStop } from './control';

/**
 * Xóa tiến trình và voice kèm theo (FR-023). Tiến trình đang chạy bị từ chối trừ khi `stopFirst`
 * (khi đó dừng rồi chờ dừng hẳn trước khi xóa). Xóa sạch: bản ghi (cascade), file voice, cache không còn dùng,
 * trả lại dung lượng, giảm `voice_count` và cập nhật `updated_at` của Project trong cùng giao dịch.
 */
export type DeleteJobsResult = { deleted: string[]; rejectedRunning: string[]; notFound: string[]; busy: string[] };

const WAIT_STOP_MS = 20_000;

/** Chờ các tiến trình thôi ở trạng thái `running`. Trả danh sách còn chạy sau khi hết giờ. */
export async function waitUntilNotRunning(jobIds: string[], timeoutMs = WAIT_STOP_MS): Promise<string[]> {
  if (jobIds.length === 0) return [];
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await getDb()
      .select({ id: voiceJobs.id })
      .from(voiceJobs)
      .where(and(inArray(voiceJobs.id, jobIds), eq(voiceJobs.status, 'running')));
    if (rows.length === 0 || Date.now() >= deadline) return rows.map((r) => r.id);
    await new Promise((r) => setTimeout(r, 150));
  }
}

export async function deleteJobs(ownerId: string, ids: string[], opts: { stopFirst?: boolean; waitMs?: number } = {}): Promise<DeleteJobsResult> {
  const db = getDb();
  const result: DeleteJobsResult = { deleted: [], rejectedRunning: [], notFound: [], busy: [] };
  // id sai định dạng coi như không tồn tại (tránh lỗi truy vấn → 500)
  const valid = ids.filter(isUuid);
  const rows = valid.length ? await db.select().from(voiceJobs).where(and(eq(voiceJobs.ownerId, ownerId), inArray(voiceJobs.id, valid))) : [];
  const found = new Set(rows.map((r) => r.id));
  result.notFound = ids.filter((id) => !found.has(id));

  const active = rows.filter((r) => r.status === 'queued' || r.status === 'running');
  let toDelete = rows;
  if (active.length > 0) {
    if (!opts.stopFirst) {
      result.rejectedRunning = active.map((r) => r.id);
      toDelete = rows.filter((r) => !result.rejectedRunning.includes(r.id));
    } else {
      await requestStop(ownerId, active.map((r) => r.id));
      const stillRunning = await waitUntilNotRunning(active.map((r) => r.id), opts.waitMs);
      result.busy = stillRunning;
      toDelete = rows.filter((r) => !stillRunning.includes(r.id));
    }
  }

  for (const job of toDelete) {
    const [voice] = await db.select().from(voices).where(eq(voices.jobId, job.id));
    const candidates = await cacheIdsReferencedByJobs([job.id]);
    await db.transaction(async (tx) => {
      await tx.delete(voiceJobs).where(and(eq(voiceJobs.id, job.id), eq(voiceJobs.ownerId, ownerId))); // cascade: voice, job_segments, job_logs
      if (voice) {
        await tx
          .update(projects)
          .set({ voiceCount: sql`greatest(0, ${projects.voiceCount} - 1)`, updatedAt: sql`now()` })
          .where(eq(projects.id, job.projectId));
      } else {
        await tx.update(projects).set({ updatedAt: sql`now()` }).where(eq(projects.id, job.projectId));
      }
    });
    if (voice) await purgeObjects(ownerId, [{ key: voice.storageKey, size: voice.sizeBytes }]);
    await purgeOrphanCache(ownerId, candidates);
    result.deleted.push(job.id);
  }
  return result;
}
