import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { and, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { HttpError, notFound } from '../api/errors';
import { getDb, type Db } from '../db';
import { VIDEO_EXPORT_ACTIVE, videoExports, videoJobs } from '../db/schema';
import { missingChars, type FontCoverage } from '../overlay/fonts';
import { isUuid } from '../projects/access';
import { deleteObject } from '../storage/client';
import { serveObject } from '../storage/proxy';
import { enqueueVideoRender } from '../../worker/queues';
import { requestStopVideoExports } from './control';
import { loadCues } from './cues';
import { estimateBurn, type BurnEstimate } from './estimate';
import { recomputeSourceExpiry } from './expiry';
import { appendVideoLog } from './log';
import { LEASE_MS } from './media';
import { requireVideoPermission, type VideoPrincipal } from './permission';
import { addVideoUsed, assertJobSlot, assertVideoRoom, videoQuotaInfo, withVideoLock } from './quota';
import { getOwnedVideoJob, videoExportDto, type VideoExportDto } from './service';
import { cuesEditable } from './status';
import { parseStoredStyle, toAppliedCues, type VideoStyle } from './style';
import type { Cue } from './types';

/**
 * Bản xuất video gắn cứng phụ đề (spec 006, US3; FR-037, FR-042, FR-043, FR-053, FR-054). Nội dung và kiểu được chốt lúc tạo; chỗ trong
 * hạn mức được giữ bằng dung lượng ước tính cho tới khi có thành phẩm.
 */

export const exportRequestSchema = z.object({ kind: z.literal('burn'), format: z.literal('mp4'), baseRevision: z.number().int().min(0) }).strict();

type JobRow = typeof videoJobs.$inferSelect;
export type ExportRow = typeof videoExports.$inferSelect;
type Principal = VideoPrincipal & { id: string };

export async function getOwnedExport(ownerId: string, exportId: string, db: Db = getDb()): Promise<ExportRow> {
  if (!isUuid(exportId)) throw notFound();
  const [row] = await db
    .select()
    .from(videoExports)
    .where(and(eq(videoExports.id, exportId), eq(videoExports.ownerId, ownerId)))
    .limit(1);
  if (!row) throw notFound();
  return row;
}

/** Xuất được khi video nguồn đã tải và kiểm xong (FR-043) và kịch bản không sắp bị lượt dịch khác thay. */
function assertExportable(job: JobRow): asserts job is JobRow & { media: NonNullable<JobRow['media']>; sourceKey: string } {
  if (job.sourceState === 'deleted' || job.sourceState === 'rejected') throw new HttpError(409, 'VIDEO_SOURCE_GONE');
  if (job.sourceState !== 'ready' || !job.media || !job.sourceKey) throw new HttpError(409, 'VIDEO_SOURCE_NOT_READY');
  if (!cuesEditable(job)) throw new HttpError(409, 'VIDEO_NOT_EDITABLE');
}

async function assertNoOpenExport(db: Db, jobId: string): Promise<void> {
  const [open] = await db
    .select({ id: videoExports.id })
    .from(videoExports)
    .where(and(eq(videoExports.jobId, jobId), inArray(videoExports.status, [...VIDEO_EXPORT_ACTIVE])));
  if (open) throw new HttpError(409, 'VIDEO_EXPORT_RUNNING');
}

let coverage: Promise<FontCoverage | null> | null = null;
const loadCoverage = () =>
  (coverage ??= readFile(path.resolve(process.cwd(), 'public/fonts/overlay/coverage.json'), 'utf8')
    .then((s) => JSON.parse(s) as FontCoverage)
    .catch(() => null));

async function missingGlyphs(cues: readonly Cue[], style: VideoStyle): Promise<string[]> {
  const known = await loadCoverage();
  if (!known) return [];
  const missing = new Set<string>();
  for (const c of toAppliedCues(cues, style.display)) for (const ch of missingChars(c.text, style.font.family, style.font.weight, known)) missing.add(ch);
  return [...missing].slice(0, 20);
}

export type ExportEstimateDto = {
  estimatedBytes: number;
  estimatedSeconds: number;
  width: number;
  height: number;
  warnings: BurnEstimate['warnings'];
  revision: number;
  /** mã lỗi sẽ gặp nếu bấm xuất ngay bây giờ; null khi xuất được */
  blocked: string | null;
  /** chỗ còn lại trong hạn mức video */
  remainingBytes: number;
};

/** Ước tính trước khi xuất, kèm lý do nếu chưa xuất được. Không giữ chỗ. */
export async function estimateExport(user: Principal, jobId: string): Promise<ExportEstimateDto> {
  const job = await getOwnedVideoJob(user.id, jobId);
  const cues = await loadCues(job.id);
  const style = parseStoredStyle(job.style);
  const estimate = job.media ? estimateBurn(job.media) : null;
  let blocked: string | null = null;
  try {
    requireVideoPermission(user);
    assertExportable(job);
    if (toAppliedCues(cues, style.display).length === 0) throw new HttpError(422, 'VIDEO_NO_CUES');
    await withVideoLock(async (tx) => {
      await assertNoOpenExport(tx, job.id);
      await assertJobSlot(tx, user.id, { excludeJobId: job.id });
      await assertVideoRoom(tx, user.id, estimate!.bytes);
    });
  } catch (e) {
    if (!(e instanceof HttpError)) throw e;
    blocked = e.code;
  }
  const warnings = [...(estimate?.warnings ?? [])];
  const missing = await missingGlyphs(cues, style);
  if (missing.length > 0) warnings.push({ code: 'MISSING_GLYPH', params: { chars: missing.join(' ') } });
  return {
    estimatedBytes: estimate?.bytes ?? 0,
    estimatedSeconds: estimate?.seconds ?? 0,
    width: estimate?.width ?? 0,
    height: estimate?.height ?? 0,
    warnings,
    revision: job.cueRevision,
    blocked,
    remainingBytes: (await videoQuotaInfo(user.id)).remainingBytes,
  };
}

async function enqueue(exportId: string): Promise<void> {
  // hàng đợi tạm không nhận được thì sweeper xếp lại
  await enqueueVideoRender(exportId).catch((e) => console.error('[video] không xếp được việc xuất:', e instanceof Error ? e.message : e));
}

export async function createExport(user: Principal, jobId: string, raw: unknown): Promise<VideoExportDto> {
  await getOwnedVideoJob(user.id, jobId);
  requireVideoPermission(user);
  const body = exportRequestSchema.parse(raw);
  const row = await withVideoLock(async (tx) => {
    const [job] = await tx
      .select()
      .from(videoJobs)
      .where(and(eq(videoJobs.id, jobId), eq(videoJobs.ownerId, user.id)))
      .for('update');
    if (!job) throw notFound();
    assertExportable(job);
    if (job.cueRevision !== body.baseRevision) throw new HttpError(409, 'CUE_CONFLICT', undefined, { revision: String(job.cueRevision) });
    const cues = await loadCues(job.id, tx);
    const style = parseStoredStyle(job.style);
    if (toAppliedCues(cues, style.display).length === 0) throw new HttpError(422, 'VIDEO_NO_CUES');
    await assertNoOpenExport(tx, job.id);
    await assertJobSlot(tx, user.id, { excludeJobId: job.id });
    const estimate = estimateBurn(job.media);
    await assertVideoRoom(tx, user.id, estimate.bytes);
    const [created] = await tx
      .insert(videoExports)
      .values({ jobId: job.id, ownerId: user.id, kind: body.kind, format: body.format, style, cues, cueRevision: job.cueRevision, estimatedBytes: estimate.bytes, durationMs: job.media.durationMs })
      .returning();
    await tx.update(videoJobs).set({ lastActivityAt: new Date(), updatedAt: new Date() }).where(eq(videoJobs.id, job.id));
    await recomputeSourceExpiry(job.id, tx);
    return created!;
  });
  await appendVideoLog(jobId, 'info', 'exportQueued', undefined, { exportId: row.id });
  await enqueue(row.id);
  return videoExportDto(row);
}

export async function stopExport(ownerId: string, exportId: string): Promise<{ status: 'stopped' | 'stopping' }> {
  const row = await getOwnedExport(ownerId, exportId);
  const r = await requestStopVideoExports(ownerId, [row.id]);
  if (r.stopped.length + r.stopRequested.length === 0) throw new HttpError(409, 'CONFLICT');
  return { status: r.stopped.length > 0 ? 'stopped' : 'stopping' };
}

/** Chạy lại bản xuất lỗi hoặc đã dừng bằng đúng nội dung đã chốt (FR-050). */
export async function rerunExport(user: Principal, exportId: string): Promise<VideoExportDto> {
  const row = await getOwnedExport(user.id, exportId);
  requireVideoPermission(user);
  const updated = await withVideoLock(async (tx) => {
    const [job] = await tx.select().from(videoJobs).where(eq(videoJobs.id, row.jobId)).for('update');
    if (!job) throw notFound();
    if (job.sourceState === 'deleted' || job.sourceState === 'rejected') throw new HttpError(409, 'VIDEO_SOURCE_GONE');
    if (job.sourceState !== 'ready') throw new HttpError(409, 'VIDEO_SOURCE_NOT_READY');
    await assertNoOpenExport(tx, job.id);
    await assertJobSlot(tx, user.id, { excludeJobId: job.id });
    await assertVideoRoom(tx, user.id, row.estimatedBytes);
    const [next] = await tx
      .update(videoExports)
      .set({ status: 'queued', progressPercent: 50, errorCode: null, cancelRequested: false, interruptions: 0, heartbeatAt: null, startedAt: null, finishedAt: null })
      .where(and(eq(videoExports.id, row.id), inArray(videoExports.status, ['failed', 'stopped'])))
      .returning();
    if (!next) throw new HttpError(409, 'CONFLICT');
    await tx.update(videoJobs).set({ lastActivityAt: new Date(), updatedAt: new Date() }).where(eq(videoJobs.id, job.id));
    await recomputeSourceExpiry(job.id, tx);
    return next;
  });
  await appendVideoLog(row.jobId, 'info', 'rerun', undefined, { exportId: row.id });
  await enqueue(row.id);
  return videoExportDto(updated);
}

/** Xóa một bản xuất: tiến trình đang chạy tự dừng khi thấy bản ghi mất; trả dung lượng ngay (FR-045, FR-054). */
export async function deleteExport(ownerId: string, exportId: string): Promise<void> {
  const row = await getOwnedExport(ownerId, exportId);
  await requestStopVideoExports(ownerId, [row.id]);
  const key = await withVideoLock(async (tx) => {
    const [cur] = await tx.select().from(videoExports).where(eq(videoExports.id, row.id)).for('update');
    if (!cur) return null;
    await tx.delete(videoExports).where(eq(videoExports.id, cur.id));
    if (cur.status === 'completed') await addVideoUsed(ownerId, -(cur.outputBytes ?? 0), tx);
    await recomputeSourceExpiry(cur.jobId, tx);
    return cur.outputKey;
  });
  if (key) await deleteObject(key).catch(() => undefined);
}

/** Thành phẩm quá hạn giữ (không còn lượt tải đang chạy): xóa tệp, trả dung lượng, giữ bản ghi. Trả false nếu chưa xóa được. */
export async function expireExport(exportId: string, now: Date = new Date()): Promise<boolean> {
  const gone = await withVideoLock(async (tx) => {
    const [cur] = await tx
      .select()
      .from(videoExports)
      .where(
        and(
          eq(videoExports.id, exportId),
          eq(videoExports.status, 'completed'),
          lt(videoExports.expiresAt, now),
          or(isNull(videoExports.downloadLeaseUntil), lt(videoExports.downloadLeaseUntil, now)),
        ),
      )
      .for('update');
    if (!cur) return null;
    await tx.update(videoExports).set({ status: 'expired', outputKey: null }).where(eq(videoExports.id, cur.id));
    await addVideoUsed(cur.ownerId, -(cur.outputBytes ?? 0), tx);
    await recomputeSourceExpiry(cur.jobId, tx);
    return cur;
  });
  if (!gone) return false;
  if (gone.outputKey) await deleteObject(gone.outputKey).catch(() => undefined);
  await appendVideoLog(gone.jobId, 'info', 'outputExpired', undefined, { exportId: gone.id });
  return true;
}

const renewDownloadLease = (exportId: string) =>
  getDb()
    .update(videoExports)
    .set({ downloadLeaseUntil: sql`now() + (${LEASE_MS} * interval '1 millisecond')` })
    .where(eq(videoExports.id, exportId));

/** Tải thành phẩm; hỗ trợ `Range` và giữ thẻ lượt tải để việc dọn dẹp không xóa giữa chừng. */
export async function serveExport(ownerId: string, exportId: string, request: Request): Promise<Response> {
  const row = await getOwnedExport(ownerId, exportId);
  if (row.status === 'expired' || (row.status === 'completed' && row.expiresAt!.getTime() <= Date.now())) throw new HttpError(409, 'VIDEO_EXPORT_EXPIRED');
  if (row.status !== 'completed' || !row.outputKey) throw new HttpError(409, 'CONFLICT');
  const job = await getOwnedVideoJob(ownerId, row.jobId);
  const base = job.originalFileName.replace(/\.[A-Za-z0-9]{1,5}$/, '') || 'video';
  const preview = new URL(request.url).searchParams.get('inline') === 'true';
  return serveObject(row.outputKey, {
    contentType: 'video/mp4',
    downloadName: preview ? undefined : `${base}-phu-de.${row.format}`,
    rangeHeader: request.headers.get('range'),
    signal: request.signal,
    onStreaming: () => renewDownloadLease(row.id),
  });
}
