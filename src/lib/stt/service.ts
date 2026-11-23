import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { HttpError, notFound } from '../api/errors';
import { getDb } from '../db';
import { STT_ACTIVE_STATUSES, sttJobLogs, sttJobs, type SttTargetFormat } from '../db/schema';
import { getOwnedProject, isUuid } from '../projects/access';
import { getSettings } from '../settings';
import { deleteObject, putObjectStream } from '../storage/client';
import { storageKeys } from '../storage/keys';
import { enqueueTranscribeMedia } from '../../worker/queues';
import { getSttConfigRow } from './config';

/**
 * Tạo và đọc STT job (spec 004, US1/US3). Mọi truy cập theo chủ sở hữu (Nguyên tắc I): job/Project của người khác → 404.
 * File media tạm KHÔNG tính vào hạn mức lưu trữ (FR-001); chỉ bị chặn bởi giới hạn dung lượng ở đây và thời lượng ở worker.
 */

export const AUDIO_EXTS = ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg'] as const;
export const VIDEO_EXTS = ['mp4', 'mov', 'mkv', 'webm'] as const;
const MB = 1024 * 1024;
export const MAX_AUDIO_BYTES = 100 * MB;
export const MAX_VIDEO_BYTES = 500 * MB;
/** FR-001: tối đa 60 phút mỗi tệp (worker kiểm tra bằng ffprobe trước khi gửi Soniox) */
export const MAX_MEDIA_DURATION_MS = 60 * 60_000;

export function mediaKindOf(fileName: string): { ext: string; kind: 'audio' | 'video' } | null {
  const m = /\.([a-z0-9]+)$/i.exec(fileName.trim());
  const ext = m?.[1]?.toLowerCase();
  if (!ext) return null;
  if ((AUDIO_EXTS as readonly string[]).includes(ext)) return { ext, kind: 'audio' };
  if ((VIDEO_EXTS as readonly string[]).includes(ext)) return { ext, kind: 'video' };
  return null;
}

export const sttOptionsSchema = z
  .object({
    targetFormat: z.enum(['srt', 'txt', 'md']).default('srt'),
    targetFileName: z.string().trim().max(200).optional(),
    language: z
      .string()
      .trim()
      .regex(/^(auto|[a-z]{2,3}(-[a-z]{2,4})?)$/i)
      .default('auto'),
    enableDiarization: z.boolean().optional(),
  })
  .strict();
export type SttOptions = z.infer<typeof sttOptionsSchema>;

/** Tên kịch bản kết quả: tên người dùng nhập (hoặc tên tệp gốc) bỏ đuôi cũ + đuôi theo định dạng. */
export function resultFileName(original: string, wanted: string | undefined, format: SttTargetFormat): string {
  const base = (wanted && wanted.trim() ? wanted.trim() : original)
    .replace(/\.[a-z0-9]{1,5}$/i, '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
    .trim()
    .slice(0, 180);
  return `${base || 'phu-de'}.${format}`;
}

type JobRow = typeof sttJobs.$inferSelect;

export type SttJobDto = {
  id: string;
  projectId: string;
  originalFileName: string;
  mediaType: 'audio' | 'video';
  fileSizeBytes: number;
  targetFormat: SttTargetFormat;
  targetFileName: string;
  language: string;
  enableDiarization: boolean;
  status: JobRow['status'];
  progressPercent: number;
  stageMessage: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  audioDurationMs: number | null;
  resultSubtitleFileId: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
};

export function sttJobDto(r: JobRow): SttJobDto {
  return {
    id: r.id,
    projectId: r.projectId,
    originalFileName: r.originalFileName,
    mediaType: r.mediaType,
    fileSizeBytes: r.fileSizeBytes,
    targetFormat: r.targetFormat,
    targetFileName: r.targetFileName,
    language: r.language,
    enableDiarization: r.enableDiarization,
    status: r.status,
    progressPercent: r.progressPercent,
    stageMessage: r.stageMessage,
    errorCode: r.errorCode,
    errorMessage: r.errorMessage,
    audioDurationMs: r.audioDurationMs,
    resultSubtitleFileId: r.resultSubtitleFileId,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    finishedAt: r.finishedAt?.toISOString() ?? null,
  };
}

export type SttLogDto = { id: number; ts: string; level: 'info' | 'warn' | 'error'; messageKey: string; params: Record<string, string | number> | null };

/** Khóa tư vấn theo User để việc đếm job đang chạy rồi tạo job mới là nguyên tử (FR-017). */
const STT_ADMISSION_LOCK = 727_004;

export type MediaUpload = { name: string; size: number; type?: string; stream: () => ReadableStream<Uint8Array> };

export async function createSttJob(user: { id: string }, projectId: string, file: MediaUpload, rawOpts: unknown): Promise<SttJobDto> {
  // (1) Quyền sở hữu Project: của người khác → 404 như không tồn tại
  await getOwnedProject(user.id, projectId);
  const opts = sttOptionsSchema.parse(rawOpts ?? {});

  // (2) Định dạng và dung lượng
  const media = mediaKindOf(file.name);
  if (!media) throw new HttpError(422, 'MEDIA_UNSUPPORTED');
  const limit = media.kind === 'video' ? MAX_VIDEO_BYTES : MAX_AUDIO_BYTES;
  if (file.size <= 0) throw new HttpError(422, 'MEDIA_UNSUPPORTED');
  if (file.size > limit) throw new HttpError(413, 'MEDIA_TOO_LARGE');

  // Soniox phải được cấu hình và đang bật (báo sớm thay vì để job lỗi)
  const cfg = await getSttConfigRow();
  if (!cfg || !cfg.enabled) throw new HttpError(409, 'STT_NOT_CONFIGURED');

  // (3) Giới hạn số job đang chờ/chạy của User (nguyên tử)
  const { maxSttJobsPerUser } = await getSettings();
  const jobId = randomUUID();
  const key = storageKeys.sttTemp(user.id, jobId, media.ext);
  const db = getDb();
  const row = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${STT_ADMISSION_LOCK}, hashtext(${user.id}))`);
    const [{ n } = { n: 0 }] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(sttJobs)
      .where(and(eq(sttJobs.ownerId, user.id), inArray(sttJobs.status, [...STT_ACTIVE_STATUSES])));
    if (n >= maxSttJobsPerUser) throw new HttpError(429, 'STT_TOO_MANY_JOBS');
    const [r] = await tx
      .insert(sttJobs)
      .values({
        id: jobId,
        projectId,
        ownerId: user.id,
        originalFileName: file.name.slice(0, 255),
        mediaType: media.kind,
        fileSizeBytes: file.size,
        tempStorageKey: key,
        targetFormat: opts.targetFormat,
        targetFileName: resultFileName(file.name, opts.targetFileName, opts.targetFormat),
        language: opts.language.toLowerCase(),
        enableDiarization: opts.enableDiarization ?? cfg.enableDiarization,
        status: 'queued',
        stageMessage: 'queued',
      })
      .returning();
    return r!;
  });

  // (4) Lưu file tạm theo luồng (không giữ cả tệp trong bộ nhớ). Lỗi → xóa job vừa tạo.
  try {
    await putObjectStream(key, file.stream(), file.size, file.type || 'application/octet-stream');
  } catch (e) {
    await db.delete(sttJobs).where(eq(sttJobs.id, jobId));
    await deleteObject(key).catch(() => undefined);
    throw e;
  }

  try {
    await enqueueTranscribeMedia(jobId);
  } catch {
    await db.delete(sttJobs).where(eq(sttJobs.id, jobId));
    await deleteObject(key).catch(() => undefined);
    throw new HttpError(503, 'INTERNAL', 'Hệ thống tạm thời chưa nhận được việc mới. Hãy thử lại sau ít phút.');
  }
  return sttJobDto(row);
}

export async function listProjectSttJobs(ownerId: string, projectId: string): Promise<SttJobDto[]> {
  await getOwnedProject(ownerId, projectId);
  const rows = await getDb()
    .select()
    .from(sttJobs)
    .where(and(eq(sttJobs.projectId, projectId), eq(sttJobs.ownerId, ownerId)))
    .orderBy(desc(sttJobs.createdAt))
    .limit(50);
  return rows.map(sttJobDto);
}

export async function getOwnedSttJob(ownerId: string, jobId: string): Promise<JobRow> {
  if (!isUuid(jobId)) throw notFound();
  const [row] = await getDb()
    .select()
    .from(sttJobs)
    .where(and(eq(sttJobs.id, jobId), eq(sttJobs.ownerId, ownerId)))
    .limit(1);
  if (!row) throw notFound();
  return row;
}

/** Chi tiết job + 50 dòng nhật ký gần nhất (FR-020). */
export async function getSttJobDetail(ownerId: string, jobId: string): Promise<SttJobDto & { logs: SttLogDto[] }> {
  const row = await getOwnedSttJob(ownerId, jobId);
  const logs = await getDb()
    .select()
    .from(sttJobLogs)
    .where(eq(sttJobLogs.sttJobId, jobId))
    .orderBy(desc(sttJobLogs.id))
    .limit(50);
  return {
    ...sttJobDto(row),
    logs: logs
      .reverse()
      .map((l) => ({ id: l.id, ts: l.ts.toISOString(), level: l.level, messageKey: l.messageKey, params: l.params ?? null })),
  };
}

/** Job đang chờ/chạy của User (banner tiến trình nền). */
export async function listActiveSttJobs(ownerId: string, projectId?: string): Promise<SttJobDto[]> {
  const conds = [eq(sttJobs.ownerId, ownerId), inArray(sttJobs.status, [...STT_ACTIVE_STATUSES])];
  if (projectId) conds.push(eq(sttJobs.projectId, projectId));
  const rows = await getDb()
    .select()
    .from(sttJobs)
    .where(and(...conds))
    .orderBy(asc(sttJobs.createdAt));
  return rows.map(sttJobDto);
}
