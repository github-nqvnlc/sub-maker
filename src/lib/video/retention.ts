import { and, eq, gt, inArray, isNotNull, isNull, lt, lte, notExists, notInArray, or, sql } from 'drizzle-orm';
import { getDb } from '../db';
import { VIDEO_EXPORT_ACTIVE, VIDEO_PIPELINE_ACTIVE, videoExports, videoJobs, videoUploads } from '../db/schema';
import { getSettings } from '../settings';
import { deleteObject, headObject } from '../storage/client';
import { storageKeys } from '../storage/keys';
import { expireExport } from './exports';
import { appendVideoLog } from './log';
import { providerSnapshot, releaseProviderData } from './provider-data';
import { addVideoUsed, withVideoLock } from './quota';

/**
 * Dọn dữ liệu video hết hạn giữ (spec 006, FR-017, FR-054, research R13). CHỈ ĐỌC `source_expires_at` (do `recomputeSourceExpiry` ghi);
 * không xóa khi còn tiến trình, phiên tải hoặc thẻ giữ lượt tải. Gọi lại nhiều lần an toàn.
 */
export type RetentionResult = { sources: string[]; exports: string[]; transcripts: string[] };

const BATCH = 200;
const TRANSCRIPT_WINDOW_MS = 3 * 24 * 3600_000;

/** Việc đến hạn xóa video nguồn và không có gì đang dùng nó. */
const dueSource = (now: Date) =>
  and(
    inArray(videoJobs.sourceState, ['checking', 'ready', 'rejected']),
    or(isNotNull(videoJobs.sourceKey), isNotNull(videoJobs.previewKey), isNotNull(videoJobs.audioTempKey)),
    lte(videoJobs.sourceExpiresAt, now),
    or(isNull(videoJobs.sourceLeaseUntil), lt(videoJobs.sourceLeaseUntil, now)),
    notInArray(videoJobs.status, [...VIDEO_PIPELINE_ACTIVE]),
    notExists(
      getDb()
        .select({ one: sql`1` })
        .from(videoExports)
        .where(and(eq(videoExports.jobId, videoJobs.id), inArray(videoExports.status, [...VIDEO_EXPORT_ACTIVE]))),
    ),
    notExists(
      getDb()
        .select({ one: sql`1` })
        .from(videoUploads)
        .where(and(eq(videoUploads.jobId, videoJobs.id), inArray(videoUploads.state, ['active', 'completing']))),
    ),
  );

/** Xóa video nguồn cùng tệp dẫn xuất (bản xem trước, âm thanh) và trả hạn mức. */
async function expireSource(jobId: string, now: Date): Promise<boolean> {
  const gone = await withVideoLock(async (tx) => {
    const [job] = await tx
      .select()
      .from(videoJobs)
      .where(and(eq(videoJobs.id, jobId), dueSource(now)))
      .for('update');
    if (!job) return null;
    await tx
      .update(videoJobs)
      .set({ sourceKey: null, sourceState: 'deleted', sourceExpiresAt: null, previewKey: null, previewState: 'none', previewBytes: null, audioTempKey: null, updatedAt: now })
      .where(eq(videoJobs.id, job.id));
    if (job.sourceKey) await addVideoUsed(job.ownerId, -job.fileSizeBytes, tx);
    return job;
  });
  if (!gone) return false;
  for (const key of [gone.sourceKey, gone.previewKey, gone.audioTempKey]) if (key) await deleteObject(key).catch(() => undefined);
  await appendVideoLog(gone.id, 'info', 'sourceExpired');
  return true;
}

export async function runVideoRetention(now: Date = new Date()): Promise<RetentionResult> {
  const db = getDb();
  const result: RetentionResult = { sources: [], exports: [], transcripts: [] };

  const sources = await db.select({ id: videoJobs.id }).from(videoJobs).where(dueSource(now)).limit(BATCH);
  for (const j of sources) if (await expireSource(j.id, now)) result.sources.push(j.id);

  const outputs = await db
    .select({ id: videoExports.id })
    .from(videoExports)
    .where(and(eq(videoExports.status, 'completed'), lt(videoExports.expiresAt, now), or(isNull(videoExports.downloadLeaseUntil), lt(videoExports.downloadLeaseUntil, now))))
    .limit(BATCH);
  for (const e of outputs) if (await expireExport(e.id, now)) result.exports.push(e.id);

  // Token thô còn sót (lượt dịch lỗi) và dữ liệu còn ở nhà cung cấp của việc không còn chạy, quá hạn không hoạt động
  const { videoIdleRetainDays } = await getSettings();
  const idle = new Date(now.getTime() - videoIdleRetainDays * 24 * 3600_000);
  const stale = await db
    .select()
    .from(videoJobs)
    .where(and(notInArray(videoJobs.status, [...VIDEO_PIPELINE_ACTIVE, 'waiting_media']), or(isNotNull(videoJobs.sonioxFileId), isNotNull(videoJobs.sonioxTranscriptionId))))
    .limit(BATCH);
  for (const job of stale) await releaseProviderData(providerSnapshot(job)).catch(() => false);
  // chỉ việc vừa qua ngưỡng trong vài ngày gần đây: lượt quét chạy mỗi 10 phút nên không sót, và không quét lại mãi việc cũ
  const old = await db
    .select({ id: videoJobs.id, ownerId: videoJobs.ownerId, runs: videoJobs.translationRun })
    .from(videoJobs)
    .where(
      and(
        notInArray(videoJobs.status, [...VIDEO_PIPELINE_ACTIVE]),
        sql`${videoJobs.cueRun} < ${videoJobs.translationRun}`,
        lt(videoJobs.lastActivityAt, idle),
        gt(videoJobs.lastActivityAt, new Date(idle.getTime() - TRANSCRIPT_WINDOW_MS)),
      ),
    )
    .limit(BATCH);
  for (const job of old) {
    for (let run = 1; run <= job.runs; run++) {
      const key = storageKeys.videoTranscript(job.ownerId, job.id, run);
      if (!(await headObject(key).catch(() => null))) continue;
      await deleteObject(key).catch(() => undefined);
      result.transcripts.push(job.id);
    }
  }
  return result;
}
