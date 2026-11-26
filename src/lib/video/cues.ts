import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { HttpError, notFound } from '../api/errors';
import { getDb, type Db } from '../db';
import { videoCues, videoJobs } from '../db/schema';
import { releaseBytes, reserveBytes } from '../storage/quota';
import { applyOps, MAX_CUE_OPS, type CueOp } from './cue-ops';
import { recomputeSourceExpiry } from './expiry';
import { getOwnedVideoJob } from './service';
import { cuesEditable } from './status';
import { CUE_TIMINGS, cueBytes, type Cue } from './types';

/** Đọc và sửa cue ở máy chủ (spec 006, T058; FR-023, FR-024, FR-055). */

export type CueListDto = { revision: number; cues: Cue[] };

const CHUNK = 1000;

const flagsSchema = z.object({ untranslated: z.boolean().optional(), fast: z.boolean().optional(), review: z.boolean().optional() }).strict();
const ms = z.number().int();
const text = z.string().max(10_000);
const cueSchema = z
  .object({
    id: z.string().uuid(),
    startMs: ms,
    endMs: ms,
    timing: z.enum(CUE_TIMINGS),
    sourceText: text,
    targetText: text,
    sourceLang: z.string().max(20).nullable(),
    speaker: z.string().max(40).nullable(),
    flags: flagsSchema,
  })
  .strict();
const opSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('update'),
      id: z.string().uuid(),
      patch: z.object({ startMs: ms, endMs: ms, sourceText: text, targetText: text, timing: z.enum(CUE_TIMINGS), flags: flagsSchema }).partial().strict(),
    })
    .strict(),
  z.object({ type: z.literal('insert'), cue: cueSchema }).strict(),
  z.object({ type: z.literal('delete'), id: z.string().uuid() }).strict(),
]);
export const cueBatchSchema = z.object({ baseRevision: z.number().int().min(0), ops: z.array(opSchema).min(1).max(MAX_CUE_OPS) }).strict();

/** Mọi cột trừ `job_id`. */
const CUE_COLUMNS = {
  id: videoCues.id,
  startMs: videoCues.startMs,
  endMs: videoCues.endMs,
  timing: videoCues.timing,
  sourceText: videoCues.sourceText,
  targetText: videoCues.targetText,
  sourceLang: videoCues.sourceLang,
  speaker: videoCues.speaker,
  flags: videoCues.flags,
};

export async function loadCues(jobId: string, db: Db = getDb()): Promise<Cue[]> {
  return db.select(CUE_COLUMNS).from(videoCues).where(eq(videoCues.jobId, jobId)).orderBy(asc(videoCues.startMs), asc(videoCues.endMs), asc(videoCues.id));
}

/** Kịch bản và số phiên bản đọc cùng một thời điểm. */
export async function getCues(ownerId: string, jobId: string): Promise<CueListDto> {
  await getOwnedVideoJob(ownerId, jobId);
  return getDb().transaction(
    async (tx) => {
      const [job] = await tx.select({ revision: videoJobs.cueRevision }).from(videoJobs).where(eq(videoJobs.id, jobId));
      if (!job) throw notFound();
      return { revision: job.revision, cues: await loadCues(jobId, tx as unknown as Db) };
    },
    { isolationLevel: 'repeatable read' },
  );
}

/**
 * Áp dụng một lô thao tác trong một giao dịch có khóa dòng việc. `baseRevision` cũ → `CUE_CONFLICT`, không ghi gì (bản sửa cũ không
 * đè bản mới). Chữ phụ đề tính vào hạn mức 500 MB ở chế độ mềm: hạn mức đầy vẫn lưu được.
 */
export async function applyCueBatch(ownerId: string, jobId: string, raw: unknown): Promise<{ revision: number }> {
  await getOwnedVideoJob(ownerId, jobId);
  const batch = cueBatchSchema.parse(raw);
  return getDb().transaction(async (tx) => {
    const db = tx as unknown as Db;
    const [job] = await tx
      .select()
      .from(videoJobs)
      .where(and(eq(videoJobs.id, jobId), eq(videoJobs.ownerId, ownerId)))
      .for('update');
    if (!job) throw notFound();
    if (!cuesEditable(job) || !job.media) throw new HttpError(409, 'VIDEO_NOT_EDITABLE');
    if (job.cueRevision !== batch.baseRevision) throw new HttpError(409, 'CUE_CONFLICT', undefined, { revision: String(job.cueRevision) });

    const result = applyOps(await loadCues(jobId, db), batch.ops as CueOp[], job.media.durationMs);
    if (!result.ok) throw new HttpError(422, 'CUE_INVALID', undefined, { id: result.violation.id, reason: result.violation.reason });
    if (result.changed.length + result.removed.length === 0) return { revision: job.cueRevision };

    const gone = [...result.removed, ...result.changed.map((c) => c.id)];
    for (let i = 0; i < gone.length; i += CHUNK) {
      await tx.delete(videoCues).where(and(eq(videoCues.jobId, jobId), inArray(videoCues.id, gone.slice(i, i + CHUNK))));
    }
    for (let i = 0; i < result.changed.length; i += CHUNK) {
      await tx.insert(videoCues).values(result.changed.slice(i, i + CHUNK).map((c) => ({ ...c, jobId })));
    }

    const bytes = result.cues.reduce((n, c) => n + cueBytes(c), 0);
    const [saved] = await tx
      .update(videoJobs)
      .set({ cueRevision: sql`${videoJobs.cueRevision} + 1`, cueCount: result.cues.length, scriptBytes: bytes, lastActivityAt: new Date(), updatedAt: new Date() })
      .where(eq(videoJobs.id, jobId))
      .returning({ revision: videoJobs.cueRevision });
    const delta = bytes - job.scriptBytes;
    if (delta > 0) await reserveBytes(ownerId, delta, { soft: true, db });
    else await releaseBytes(ownerId, -delta, db);
    await recomputeSourceExpiry(jobId, db);
    return { revision: saved!.revision };
  });
}
