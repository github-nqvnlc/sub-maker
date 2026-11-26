import { and, eq, lt, sql } from 'drizzle-orm';
import { getDb, type Db } from '../db';
import { projects, users, videoJobs } from '../db/schema';
import type { SonioxToken } from '../providers/adapters/soniox-types';
import { ProviderError } from '../providers/errors';
import { putObject } from '../storage/client';
import { storageKeys } from '../storage/keys';
import { deleteSonioxData } from '../stt/cleanup';
import { getSttConfigRow, sonioxClientFor } from '../stt/config';
import { recordVideoUsage } from '../usage/record';

/**
 * Kết quả và dữ liệu ở nhà cung cấp của việc dịch video (spec 006, FR-016, FR-017, research R5). Thứ tự bắt buộc: lấy kết quả →
 * lưu bản token thô → ghi bản ghi sử dụng → gom cue → xóa dữ liệu ở nhà cung cấp.
 */
export type RawTranscript = { run: number; model: string | null; audioDurationMs: number | null; tokens: SonioxToken[] };

export type ProviderSnapshot = {
  id: string;
  ownerId: string;
  projectId: string;
  translationRun: number;
  billedRun: number;
  model: string | null;
  sonioxFileId: string | null;
  sonioxTranscriptionId: string | null;
};

export const providerSnapshot = (j: ProviderSnapshot): ProviderSnapshot => ({
  id: j.id,
  ownerId: j.ownerId,
  projectId: j.projectId,
  translationRun: j.translationRun,
  billedRun: j.billedRun,
  model: j.model,
  sonioxFileId: j.sonioxFileId,
  sonioxTranscriptionId: j.sonioxTranscriptionId,
});

export const saveRawTranscript = (job: Pick<ProviderSnapshot, 'id' | 'ownerId'>, raw: RawTranscript): Promise<void> =>
  putObject(storageKeys.videoTranscript(job.ownerId, job.id, raw.run), JSON.stringify(raw), 'application/json');

/**
 * Ghi MỘT bản ghi tính phí cho lượt dịch, đánh dấu trên việc trong cùng giao dịch nên chạy lại sau sự cố không ghi lần hai
 * (SC-011). Việc đã bị xóa thì vẫn ghi (không gắn việc) vì nhà cung cấp đã tính phí.
 */
export async function billTranslation(
  job: ProviderSnapshot,
  audioDurationMs: number | null,
  transcriptChars: number,
  pricePerAudioHourUsd: number | null,
  opts: { jobDeleted?: boolean; db?: Db } = {},
): Promise<boolean> {
  return (opts.db ?? getDb()).transaction(async (tx) => {
    let { ownerId, projectId } = job as { ownerId: string | null; projectId: string | null };
    if (opts.jobDeleted) {
      if (job.billedRun >= job.translationRun) return false;
      // User hoặc Project có thể đã bị xóa: bản ghi vẫn còn trong thống kê tổng hợp, không gắn định danh
      if (!(await tx.select({ id: users.id }).from(users).where(eq(users.id, job.ownerId))).length) ownerId = null;
      if (!(await tx.select({ id: projects.id }).from(projects).where(eq(projects.id, job.projectId))).length) projectId = null;
    } else {
      const marked = await tx
        .update(videoJobs)
        .set({ billedRun: job.translationRun })
        .where(and(eq(videoJobs.id, job.id), lt(videoJobs.billedRun, job.translationRun)))
        .returning({ id: videoJobs.id });
      if (marked.length === 0) return false;
    }
    await recordVideoUsage(
      {
        userId: ownerId,
        projectId,
        videoJobId: opts.jobDeleted ? null : job.id,
        model: job.model,
        audioSeconds: audioDurationMs != null ? Math.round(audioDurationMs / 1000) : null,
        transcriptChars,
        pricePerAudioHourUsd,
        ok: true,
      },
      tx as unknown as Db,
    );
    return true;
  });
}

/** Lấy kết quả đã có (nếu chưa tính phí) trước khi dữ liệu bị xóa. */
async function collectResult(job: ProviderSnapshot, jobDeleted: boolean, db: Db): Promise<boolean> {
  if (!job.sonioxTranscriptionId || job.billedRun >= job.translationRun) return true;
  const cfg = await getSttConfigRow();
  if (!cfg) return false;
  try {
    const { client } = sonioxClientFor(cfg);
    const state = await client.getTranscription(job.sonioxTranscriptionId);
    if (state.status !== 'completed') return true;
    const transcript = await client.getTranscript(job.sonioxTranscriptionId);
    const audioDurationMs = state.audio_duration_ms ?? null;
    if (!jobDeleted) await saveRawTranscript(job, { run: job.translationRun, model: job.model, audioDurationMs, tokens: transcript.tokens });
    await billTranslation(job, audioDurationMs, [...(transcript.text ?? '')].length, cfg.pricePerAudioHourUsd, { jobDeleted, db });
    return true;
  } catch (e) {
    // 404: nhà cung cấp không còn bản phiên âm, chỉ còn việc xóa; lỗi khác: chưa lấy được
    return e instanceof ProviderError && e.httpStatus === 404;
  }
}

const RELEASE_LOCK = 727_012;

/**
 * Dừng, lỗi vĩnh viễn hoặc xóa việc: nhà cung cấp đã có kết quả thì lấy, lưu và ghi sử dụng TRƯỚC khi xóa (FR-017); rồi xóa dữ liệu
 * và id ở nhà cung cấp. Còn việc thì không liên lạc được sẽ giữ id để lần sau xử lý tiếp; việc đã xóa thì vẫn cố xóa dữ liệu.
 * Trả `false` khi còn dữ liệu chưa xóa được.
 */
export async function releaseProviderData(job: ProviderSnapshot, opts: { jobDeleted?: boolean } = {}): Promise<boolean> {
  const ids = { fileId: job.sonioxFileId, transcriptionId: job.sonioxTranscriptionId };
  if (!ids.fileId && !ids.transcriptionId) return true;
  if (opts.jobDeleted) {
    // người xóa và tiến trình đang chạy có thể cùng tới: khóa theo việc để chỉ ghi sử dụng một lần
    return getDb().transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${RELEASE_LOCK}, hashtext(${job.id}))`);
      await collectResult(job, true, tx as unknown as Db).catch(() => false);
      return deleteSonioxData(ids);
    });
  }
  if (!(await collectResult(job, false, getDb()).catch(() => false))) return false;
  if (!(await deleteSonioxData(ids))) return false;
  await getDb()
    .update(videoJobs)
    .set({ sonioxFileId: null, sonioxTranscriptionId: null })
    .where(and(eq(videoJobs.id, job.id), eq(videoJobs.translationRun, job.translationRun)));
  return true;
}
