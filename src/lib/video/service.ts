import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, gt, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { HttpError, notFound } from '../api/errors';
import { getDb, type Db } from '../db';
import {
  VIDEO_PIPELINE_ACTIVE,
  videoExports,
  videoJobLogs,
  videoJobs,
  videoProjectSettings,
  videoUploadParts,
  videoUploads,
  type VideoJobStatus,
} from '../db/schema';
import { getOwnedProject, isUuid } from '../projects/access';
import { getSettings } from '../settings';
import { abortMultipart, createMultipart } from '../storage/client';
import { storageKeys } from '../storage/keys';
import { getSttConfigRow } from '../stt/config';
import { enqueueVideoPrepare, enqueueVideoTranslate } from '../../worker/queues';
import { deleteVideoJobs } from './cleanup';
import { requestStopVideoJobs } from './control';
import { recomputeSourceExpiry } from './expiry';
import { appendVideoLog } from './log';
import { mayTranslate, requireVideoPermission, type VideoPrincipal } from './permission';
import { assertJobSlot, assertVideoRoom, videoQuotaInfo, withVideoLock } from './quota';
import { isBusyStatus, videoDisplayStatus, type VideoDisplayStatus } from './status';
import { parseStoredStyle, type VideoStyle } from './style';
import { DIRECTIONS, VIDEO_EXTENSIONS, type Direction, type GlossaryPair, type PreviewState, type SourceState, type VideoExtension, type VideoMedia } from './types';
import { partCountOf, UPLOAD_TTL_MS, VIDEO_PART_SIZE } from './uploads';

/**
 * Dịch vụ dịch video (spec 006). Mọi truy cập theo chủ sở hữu (Nguyên tắc I): tài nguyên của người khác, id sai định dạng hay không
 * tồn tại đều trả 404 như nhau, kể cả với Administrator.
 */
type JobRow = typeof videoJobs.$inferSelect;
type ExportRow = typeof videoExports.$inferSelect;
type Principal = VideoPrincipal & { id: string };

export const VIDEO_CONTENT_TYPES: Record<VideoExtension, string> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  webm: 'video/webm',
  avi: 'video/x-msvideo',
  flv: 'video/x-flv',
};

export type VideoUploadDto = { id: string; state: 'active' | 'completing'; sizeBytes: number; receivedBytes: number; partSize: number; partCount: number; expiresAt: string };

export type VideoExportDto = {
  id: string;
  kind: ExportRow['kind'];
  format: ExportRow['format'];
  status: ExportRow['status'];
  progressPercent: number;
  errorCode: string | null;
  estimatedBytes: number;
  sizeBytes: number | null;
  durationMs: number;
  cueRevision: number;
  createdAt: string;
  finishedAt: string | null;
  expiresAt: string | null;
};

export type VideoJobDto = {
  id: string;
  projectId: string;
  fileName: string;
  ext: VideoExtension;
  size: number;
  fingerprint: string;
  direction: Direction;
  status: VideoJobStatus;
  displayStatus: VideoDisplayStatus;
  /** tiến độ chung 0–100 (FR-049) */
  progressPercent: number;
  errorCode: string | null;
  sourceState: SourceState;
  sourceExpiresAt: string | null;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  previewState: PreviewState;
  cueCount: number;
  cueRevision: number;
  clientAudio: boolean;
  audioMismatch: boolean;
  upload: VideoUploadDto | null;
  /** hạn mức video đang dùng cho việc này: video nguồn còn giữ và thành phẩm còn giữ */
  storedBytes: number;
  canStop: boolean;
  canRerun: boolean;
  createdAt: string;
  finishedAt: string | null;
};

export function videoExportDto(r: ExportListRow): VideoExportDto {
  return {
    id: r.id,
    kind: r.kind,
    format: r.format,
    status: r.status,
    progressPercent: r.progressPercent,
    errorCode: r.errorCode,
    estimatedBytes: r.estimatedBytes,
    sizeBytes: r.outputBytes,
    durationMs: r.durationMs,
    cueRevision: r.cueRevision,
    createdAt: r.createdAt.toISOString(),
    finishedAt: r.finishedAt?.toISOString() ?? null,
    expiresAt: r.expiresAt?.toISOString() ?? null,
  };
}

/** Không nạp `cues`/`style` khi liệt kê bản xuất (có thể vài MB mỗi dòng). */
export const EXPORT_COLUMNS = {
  id: videoExports.id,
  jobId: videoExports.jobId,
  kind: videoExports.kind,
  format: videoExports.format,
  status: videoExports.status,
  progressPercent: videoExports.progressPercent,
  errorCode: videoExports.errorCode,
  estimatedBytes: videoExports.estimatedBytes,
  outputBytes: videoExports.outputBytes,
  durationMs: videoExports.durationMs,
  cueRevision: videoExports.cueRevision,
  createdAt: videoExports.createdAt,
  finishedAt: videoExports.finishedAt,
  expiresAt: videoExports.expiresAt,
} as const;
type ExportListRow = Pick<ExportRow, keyof typeof EXPORT_COLUMNS>;

/** `exports` mới nhất trước. */
export function videoJobDto(j: JobRow, exports: ReadonlyArray<ExportListRow>, upload: VideoUploadDto | null): VideoJobDto {
  const displayStatus = videoDisplayStatus(j, exports);
  const active = exports.find((e) => e.status === 'running' || e.status === 'queued' || e.status === 'interrupted');
  const progressPercent = active ? active.progressPercent : displayStatus === 'completed' ? 100 : j.progressPercent;
  // pipeline đã xong thì lỗi (nếu có) là của bản xuất mới nhất
  const exportError = displayStatus === 'failed' ? (exports[0]?.errorCode ?? null) : null;
  const errorCode = j.sourceState === 'rejected' ? j.errorCode : active ? null : j.status === 'review_ready' ? exportError : j.errorCode;
  const pipelineActive = (VIDEO_PIPELINE_ACTIVE as readonly string[]).includes(j.status);
  return {
    id: j.id,
    projectId: j.projectId,
    fileName: j.originalFileName,
    ext: j.ext,
    size: j.fileSizeBytes,
    fingerprint: j.fingerprint,
    direction: j.direction,
    status: j.status,
    displayStatus,
    progressPercent,
    errorCode,
    sourceState: j.sourceState,
    sourceExpiresAt: j.sourceExpiresAt?.toISOString() ?? null,
    durationMs: j.media?.durationMs ?? null,
    width: j.media?.width ?? null,
    height: j.media?.height ?? null,
    previewState: j.previewState,
    cueCount: j.cueCount,
    cueRevision: j.cueRevision,
    clientAudio: j.clientAudio,
    audioMismatch: j.audioMismatch,
    upload,
    storedBytes: (j.sourceKey ? j.fileSizeBytes : 0) + exports.reduce((n, e) => n + (e.status === 'completed' ? (e.outputBytes ?? 0) : 0), 0),
    canStop: pipelineActive || !!active,
    canRerun: (j.status === 'failed' || j.status === 'stopped') && canResume(j),
    createdAt: j.createdAt.toISOString(),
    finishedAt: j.finishedAt?.toISOString() ?? null,
  };
}

async function openUploads(jobIds: string[], db: Db = getDb()): Promise<Map<string, VideoUploadDto>> {
  if (jobIds.length === 0) return new Map();
  const rows = await db
    .select()
    .from(videoUploads)
    .where(and(inArray(videoUploads.jobId, jobIds), eq(videoUploads.kind, 'source'), inArray(videoUploads.state, ['active', 'completing'])));
  if (rows.length === 0) return new Map();
  const parts = await db
    .select({ uploadId: videoUploadParts.uploadId, size: videoUploadParts.size })
    .from(videoUploadParts)
    .where(inArray(videoUploadParts.uploadId, rows.map((r) => r.id)));
  const received = new Map<string, number>();
  for (const p of parts) received.set(p.uploadId, (received.get(p.uploadId) ?? 0) + p.size);
  return new Map(
    rows.map((r) => [
      r.jobId,
      {
        id: r.id,
        state: r.state as 'active' | 'completing',
        sizeBytes: r.sizeBytes,
        receivedBytes: received.get(r.id) ?? 0,
        partSize: r.partSize,
        partCount: r.partCount,
        expiresAt: r.expiresAt.toISOString(),
      },
    ]),
  );
}

async function exportsOf(jobIds: string[], db: Db = getDb()): Promise<Map<string, ExportListRow[]>> {
  const out = new Map<string, ExportListRow[]>();
  if (jobIds.length === 0) return out;
  const rows = await db.select(EXPORT_COLUMNS).from(videoExports).where(inArray(videoExports.jobId, jobIds)).orderBy(desc(videoExports.createdAt));
  for (const r of rows) out.set(r.jobId, [...(out.get(r.jobId) ?? []), r]);
  return out;
}

export async function getOwnedVideoJob(ownerId: string, id: string, db: Db = getDb()): Promise<JobRow> {
  if (!isUuid(id)) throw notFound();
  const [row] = await db
    .select()
    .from(videoJobs)
    .where(and(eq(videoJobs.id, id), eq(videoJobs.ownerId, ownerId)))
    .limit(1);
  if (!row) throw notFound();
  return row;
}

export async function toDto(job: JobRow): Promise<VideoJobDto> {
  const [uploads, exports] = await Promise.all([openUploads([job.id]), exportsOf([job.id])]);
  return videoJobDto(job, exports.get(job.id) ?? [], uploads.get(job.id) ?? null);
}

// ---- Tab của Project ----------------------------------------------------------------------------

export type VideoProjectSettingsDto = { direction: Direction; glossary: GlossaryPair[]; style: VideoStyle };

async function projectSettings(projectId: string, db: Db = getDb()): Promise<VideoProjectSettingsDto> {
  const [row] = await db.select().from(videoProjectSettings).where(eq(videoProjectSettings.projectId, projectId));
  return { direction: row?.direction ?? 'to_vi', glossary: row?.glossary ?? [], style: parseStoredStyle(row?.style) };
}

const sttReady = async (): Promise<boolean> => !!(await getSttConfigRow())?.enabled;

export async function getVideoTab(user: Principal, projectId: string) {
  await getOwnedProject(user.id, projectId);
  const settings = await getSettings();
  return {
    allowed: mayTranslate(user),
    sttConfigured: await sttReady(),
    quota: await videoQuotaInfo(user.id),
    limits: { maxBytes: settings.videoMaxBytes, maxMinutes: settings.videoMaxMinutes, extensions: [...VIDEO_EXTENSIONS] },
    retention: { sourceHours: settings.videoSourceRetainHours, idleDays: settings.videoIdleRetainDays, outputDays: settings.videoOutputRetainDays },
    settings: await projectSettings(projectId),
  };
}
export type VideoTabDto = Awaited<ReturnType<typeof getVideoTab>>;

export async function listVideoJobs(ownerId: string, projectId: string): Promise<VideoJobDto[]> {
  await getOwnedProject(ownerId, projectId);
  const rows = await getDb()
    .select()
    .from(videoJobs)
    .where(and(eq(videoJobs.projectId, projectId), eq(videoJobs.ownerId, ownerId)))
    .orderBy(desc(videoJobs.createdAt))
    .limit(100);
  const ids = rows.map((r) => r.id);
  const [uploads, exports] = await Promise.all([openUploads(ids), exportsOf(ids)]);
  return rows.map((r) => videoJobDto(r, exports.get(r.id) ?? [], uploads.get(r.id) ?? null));
}

export type VideoLogDto = { id: number; ts: string; level: 'info' | 'warn' | 'error'; messageKey: string; params: Record<string, string | number> | null; exportId: string | null };

export const videoLogDto = (l: typeof videoJobLogs.$inferSelect): VideoLogDto => ({
  id: l.id,
  ts: l.ts.toISOString(),
  level: l.level,
  messageKey: l.messageKey,
  params: l.params ?? null,
  exportId: l.exportId,
});

export type VideoJobDetailDto = VideoJobDto & { media: VideoMedia | null; style: VideoStyle; exports: VideoExportDto[]; logs: VideoLogDto[] };

/** Chi tiết việc, media, bản xuất và 50 dòng nhật ký gần nhất. */
export async function getVideoJobDetail(ownerId: string, id: string): Promise<VideoJobDetailDto> {
  const job = await getOwnedVideoJob(ownerId, id);
  const [uploads, exports] = await Promise.all([openUploads([job.id]), exportsOf([job.id])]);
  const logs = await getDb().select().from(videoJobLogs).where(eq(videoJobLogs.jobId, job.id)).orderBy(desc(videoJobLogs.id)).limit(50);
  const list = exports.get(job.id) ?? [];
  return {
    ...videoJobDto(job, list, uploads.get(job.id) ?? null),
    media: job.media,
    style: parseStoredStyle(job.style),
    exports: list.map(videoExportDto),
    logs: logs.reverse().map(videoLogDto),
  };
}

// ---- Tạo ----------------------------------------------------------------------------------------

const createSchema = z
  .object({
    fileName: z.string().trim().min(1).max(255),
    size: z.number().int().min(1),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    direction: z.enum(DIRECTIONS),
    clientAudio: z.boolean().optional(),
  })
  .strict();

export function extensionOf(fileName: string): VideoExtension | null {
  const ext = /\.([a-z0-9]+)$/i.exec(fileName)?.[1]?.toLowerCase();
  return (VIDEO_EXTENSIONS as readonly string[]).includes(ext ?? '') ? (ext as VideoExtension) : null;
}

export async function createVideoJob(user: Principal, projectId: string, raw: unknown) {
  requireVideoPermission(user);
  await getOwnedProject(user.id, projectId);
  const body = createSchema.parse(raw);
  const ext = extensionOf(body.fileName);
  if (!ext) throw new HttpError(422, 'VIDEO_UNSUPPORTED');
  const settings = await getSettings();
  if (body.size > settings.videoMaxBytes) throw new HttpError(413, 'VIDEO_TOO_LARGE', undefined, { maxBytes: String(settings.videoMaxBytes) });
  // FR-013: chưa cấu hình thì chặn TRƯỚC khi tải lên
  if (!(await sttReady())) throw new HttpError(409, 'STT_NOT_CONFIGURED');
  const prefs = await projectSettings(projectId);

  const jobId = randomUUID();
  const key = storageKeys.videoSource(user.id, jobId, ext);
  const storageUploadId = await createMultipart(key, VIDEO_CONTENT_TYPES[ext]);
  const partCount = partCountOf(body.size);
  let uploadId: string;
  try {
    uploadId = await withVideoLock(async (tx) => {
      await assertJobSlot(tx, user.id);
      await assertVideoRoom(tx, user.id, body.size);
      await tx.insert(videoJobs).values({
        id: jobId,
        projectId,
        ownerId: user.id,
        originalFileName: body.fileName.normalize('NFC'),
        ext,
        fileSizeBytes: body.size,
        fingerprint: body.fingerprint,
        direction: body.direction,
        glossary: prefs.glossary,
        style: prefs.style,
        clientAudio: body.clientAudio ?? false,
      });
      const [upload] = await tx
        .insert(videoUploads)
        .values({
          jobId,
          ownerId: user.id,
          kind: 'source',
          storageUploadId,
          key,
          sizeBytes: body.size,
          partSize: VIDEO_PART_SIZE,
          partCount,
          fingerprint: body.fingerprint,
          expiresAt: new Date(Date.now() + UPLOAD_TTL_MS),
        })
        .returning({ id: videoUploads.id });
      await tx
        .insert(videoProjectSettings)
        .values({ projectId, ownerId: user.id, direction: body.direction })
        .onConflictDoUpdate({ target: videoProjectSettings.projectId, set: { direction: body.direction, updatedAt: new Date() } });
      await recomputeSourceExpiry(jobId, tx);
      return upload!.id;
    });
  } catch (e) {
    await abortMultipart(key, storageUploadId).catch(() => undefined);
    throw e;
  }
  return { job: await toDto(await getOwnedVideoJob(user.id, jobId)), upload: { id: uploadId, partSize: VIDEO_PART_SIZE, partCount } };
}

// ---- Dừng, chạy lại, xóa ------------------------------------------------------------------------

/** Dừng pipeline dịch đang chờ hoặc đang chạy. */
export async function stopVideoJob(ownerId: string, id: string): Promise<{ status: 'stopped' | 'stopping' }> {
  const job = await getOwnedVideoJob(ownerId, id);
  const r = await requestStopVideoJobs(ownerId, [job.id]);
  if (r.stopped.length + r.stopRequested.length === 0) throw new HttpError(409, 'CONFLICT');
  await getDb().transaction(async (tx) => {
    await tx.update(videoJobs).set({ lastActivityAt: new Date() }).where(eq(videoJobs.id, job.id));
    await recomputeSourceExpiry(job.id, tx as unknown as Db);
  });
  return { status: r.stopped.length > 0 ? 'stopped' : 'stopping' };
}

/** Bước cần chạy tiếp theo: đã tách âm thanh thì dịch ngay, chưa thì chuẩn bị từ video nguồn. */
export const nextPipelineStep = (job: Pick<JobRow, 'audioTempKey' | 'media'>): 'prepare' | 'translate' => (job.audioTempKey && job.media ? 'translate' : 'prepare');

/** Còn đủ dữ liệu để chạy lại: bước chuẩn bị cần video nguồn; đã tách âm thanh rồi thì không cần. */
const canResume = (job: Pick<JobRow, 'audioTempKey' | 'media' | 'sourceState'>): boolean =>
  job.sourceState !== 'rejected' && (nextPipelineStep(job) === 'translate' || job.sourceState === 'ready' || job.sourceState === 'checking');

export async function enqueuePipeline(job: Pick<JobRow, 'id' | 'audioTempKey' | 'media'>): Promise<void> {
  await (nextPipelineStep(job) === 'translate' ? enqueueVideoTranslate(job.id) : enqueueVideoPrepare(job.id));
}

/** Chạy lại việc lỗi hoặc đã dừng, dùng lại phần đã xong (FR-016, FR-050). */
export async function rerunVideoJob(user: Principal, id: string): Promise<VideoJobDto> {
  const job = await getOwnedVideoJob(user.id, id);
  requireVideoPermission(user);
  if ((job.status !== 'failed' && job.status !== 'stopped') || job.sourceState === 'rejected') throw new HttpError(409, 'CONFLICT');
  // cần video nguồn cho bước chuẩn bị; đã tách âm thanh rồi thì không cần
  if (nextPipelineStep(job) === 'prepare' && job.sourceState !== 'ready' && job.sourceState !== 'checking') throw new HttpError(409, 'VIDEO_SOURCE_GONE');
  const updated = await withVideoLock(async (tx) => {
    await assertJobSlot(tx, user.id, { excludeJobId: job.id });
    const [row] = await tx
      .update(videoJobs)
      .set({
        status: 'queued',
        stageKey: 'queued',
        errorCode: null,
        cancelRequested: false,
        interruptions: 0,
        heartbeatAt: null,
        finishedAt: null,
        lastActivityAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(videoJobs.id, job.id), inArray(videoJobs.status, ['failed', 'stopped'])))
      .returning();
    if (row) await recomputeSourceExpiry(job.id, tx);
    return row;
  });
  if (!updated) throw new HttpError(409, 'CONFLICT');
  await appendVideoLog(job.id, 'info', 'rerun');
  await enqueuePipeline(updated).catch((e) => console.error('[video] không xếp được việc chạy lại:', e instanceof Error ? e.message : e));
  return toDto(updated);
}

/** Xóa một việc: tiến trình đang chạy tự dừng khi thấy bản ghi mất; xóa mọi tệp và trả dung lượng ngay (FR-054, FR-057). */
export async function deleteVideoJob(ownerId: string, id: string): Promise<void> {
  const job = await getOwnedVideoJob(ownerId, id);
  await requestStopVideoJobs(ownerId, [job.id]);
  await deleteVideoJobs(ownerId, { jobIds: [job.id] });
}

/** Nhật ký sau mốc `afterId`, cho luồng sự kiện. */
export async function videoLogsAfter(jobId: string, afterId: number, limit: number) {
  return getDb()
    .select()
    .from(videoJobLogs)
    .where(and(eq(videoJobLogs.jobId, jobId), gt(videoJobLogs.id, afterId)))
    .orderBy(asc(videoJobLogs.id))
    .limit(limit);
}

export const isBusyJob = (dto: Pick<VideoJobDto, 'displayStatus' | 'previewState'>): boolean => isBusyStatus(dto.displayStatus) || dto.previewState === 'pending';
