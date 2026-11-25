import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { HttpError, notFound } from '../api/errors';
import { getDb, type Db } from '../db';
import { OVERLAY_ACTIVE_STATUSES, overlayAudios, overlayConfigs, overlayJobLogs, overlayJobs, subtitleCues, users, voiceJobs, type OverlaySource } from '../db/schema';
import { getOwnedFile, getOwnedProject, getOwnedVoice, isUuid } from '../projects/access';
import { getSettings, type Settings } from '../settings';
import { purgeObjects } from '../storage/cleanup';
import { enqueueRenderOverlay } from '../../worker/queues';
import { colorWarnings } from './colors';
import { DEFAULT_CONFIG, ENGINE_VERSION, isTransparent, sizeOf, type OverlayConfig } from './config';
import { deleteOverlayObject, requestStopOverlay, waitOverlayNotRunning } from './control';
import { estimateBytes } from './estimate';
import { appendOverlayLog } from './log';
import { overlayConfigSchema, parseStoredConfig } from './schema';
import { applyTiming, type TimingSource } from './timing';
import type { AppliedCue, OverlayWarning } from './types';

/**
 * Dịch vụ video overlay (spec 005). Mọi truy cập theo chủ sở hữu (Nguyên tắc I): tài nguyên của người khác, id sai định dạng
 * hay không tồn tại đều trả 404. Nội dung phụ đề và cấu hình được CHỐT lúc bấm xuất (FR-035).
 */

type JobRow = typeof overlayJobs.$inferSelect;
/** Không nạp `cues` khi liệt kê (có thể vài trăm KB mỗi dòng). */
const JOB_COLUMNS = {
  id: overlayJobs.id,
  projectId: overlayJobs.projectId,
  ownerId: overlayJobs.ownerId,
  voiceId: overlayJobs.voiceId,
  audioId: overlayJobs.audioId,
  subtitleFileId: overlayJobs.subtitleFileId,
  sourceNames: overlayJobs.sourceNames,
  config: overlayJobs.config,
  format: overlayJobs.format,
  width: overlayJobs.width,
  height: overlayJobs.height,
  durationMs: overlayJobs.durationMs,
  estimatedBytes: overlayJobs.estimatedBytes,
  warnings: overlayJobs.warnings,
  status: overlayJobs.status,
  progressPercent: overlayJobs.progressPercent,
  errorCode: overlayJobs.errorCode,
  createdAt: overlayJobs.createdAt,
  startedAt: overlayJobs.startedAt,
  finishedAt: overlayJobs.finishedAt,
  outputStorageKey: overlayJobs.outputStorageKey,
  outputSizeBytes: overlayJobs.outputSizeBytes,
} as const;
type JobListRow = Pick<JobRow, keyof typeof JOB_COLUMNS>;

export type OverlayJobDto = {
  id: string;
  projectId: string;
  sourceNames: { voice: string; subtitle: string };
  config: OverlayConfig;
  format: JobRow['format'];
  width: number;
  height: number;
  durationMs: number;
  estimatedBytes: number;
  sizeBytes: number | null;
  warnings: OverlayWarning[];
  status: JobRow['status'];
  progressPercent: number;
  errorCode: string | null;
  canRerun: boolean;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

const hasSources = (r: Pick<JobRow, 'voiceId' | 'audioId' | 'subtitleFileId'>): boolean => !!r.subtitleFileId && !!(r.voiceId ?? r.audioId);

export function overlayJobDto(r: JobListRow): OverlayJobDto {
  return {
    id: r.id,
    projectId: r.projectId,
    sourceNames: r.sourceNames,
    config: r.config,
    format: r.format,
    width: r.width,
    height: r.height,
    durationMs: r.durationMs,
    estimatedBytes: r.estimatedBytes,
    sizeBytes: r.outputSizeBytes,
    warnings: r.warnings,
    status: r.status,
    progressPercent: r.progressPercent,
    errorCode: r.errorCode,
    canRerun: (r.status === 'failed' || r.status === 'stopped') && hasSources(r),
    createdAt: r.createdAt.toISOString(),
    startedAt: r.startedAt?.toISOString() ?? null,
    finishedAt: r.finishedAt?.toISOString() ?? null,
  };
}

// ---- Kiểm tra đầu vào ---------------------------------------------------------------------------

const INVALID_CONFIG = 'Cấu hình video overlay không hợp lệ';

/** Cấu hình do client gửi: sai bất kỳ trường nào → 422 nêu tên trường, không lộ chi tiết nội bộ. */
export function parseConfig(raw: unknown): OverlayConfig {
  const r = overlayConfigSchema.safeParse(raw);
  if (r.success) return r.data;
  const fields: Record<string, string> = {};
  for (const i of r.error.issues) fields[['config', ...i.path.map(String)].join('.')] = INVALID_CONFIG;
  throw new HttpError(422, 'VALIDATION', undefined, fields);
}

const idOrNull = z.string().uuid().nullish();
const sourceSchema = z.object({ voiceId: idOrNull, audioId: idOrNull, fileId: idOrNull }).strict();
const saveSchema = z.object({ config: z.unknown(), source: sourceSchema }).strict();
const createSchema = z
  .object({
    clientRequestId: z.string().uuid(),
    voiceId: z.string().uuid().nullish(),
    audioId: z.string().uuid().nullish(),
    fileId: z.string().uuid(),
    config: z.unknown(),
  })
  .strict();

// ---- Cấu hình gần nhất và giới hạn (FR-016) -----------------------------------------------------

/** Tổng dung lượng ước tính của các tiến trình đang hoạt động (giữ chỗ hạn mức, FR-044). */
async function pendingBytes(ownerId: string, db: Db = getDb()): Promise<number> {
  const [r] = await db
    .select({ n: sql<string>`coalesce(sum(${overlayJobs.estimatedBytes}), 0)` })
    .from(overlayJobs)
    .where(and(eq(overlayJobs.ownerId, ownerId), inArray(overlayJobs.status, [...OVERLAY_ACTIVE_STATUSES])));
  return Number(r?.n ?? 0);
}

async function usedBytesOf(ownerId: string, db: Db = getDb()): Promise<number> {
  const [r] = await db.select({ u: users.storageUsedBytes }).from(users).where(eq(users.id, ownerId));
  return r?.u ?? 0;
}

export async function getOverlayState(ownerId: string, projectId: string) {
  await getOwnedProject(ownerId, projectId);
  const [row] = await getDb().select().from(overlayConfigs).where(and(eq(overlayConfigs.projectId, projectId), eq(overlayConfigs.ownerId, ownerId)));
  const [settings, usedBytes, pending] = await Promise.all([getSettings(), usedBytesOf(ownerId), pendingBytes(ownerId)]);
  return {
    config: row ? parseStoredConfig(row.config) : structuredClone(DEFAULT_CONFIG),
    source: row?.source ?? {},
    limits: {
      maxMinutes: settings.overlayMaxMinutes,
      maxMinutesTransparent: settings.overlayMaxMinutesTransparent,
      maxJobsPerUser: settings.maxOverlayJobsPerUser,
      quotaBytes: settings.userQuotaBytes,
      usedBytes,
      pendingBytes: pending,
    },
  };
}

export async function saveOverlayState(ownerId: string, projectId: string, raw: unknown): Promise<void> {
  await getOwnedProject(ownerId, projectId);
  const body = saveSchema.parse(raw);
  const config = parseConfig(body.config);
  const source: OverlaySource = { voiceId: body.source.voiceId ?? null, audioId: body.source.audioId ?? null, fileId: body.source.fileId ?? null };
  await getDb()
    .insert(overlayConfigs)
    .values({ projectId, ownerId, config, source })
    .onConflictDoUpdate({ target: overlayConfigs.projectId, set: { config, source, updatedAt: new Date() } });
}

// ---- Nguồn voice + phụ đề → mốc áp dụng ---------------------------------------------------------

export type ResolvedSource = {
  kind: TimingSource;
  voiceId: string | null;
  audioId: string | null;
  fileId: string;
  names: { voice: string; subtitle: string };
  durationMs: number;
  cues: AppliedCue[];
  warnings: OverlayWarning[];
};

export async function getOwnedOverlayAudio(ownerId: string, id: string) {
  if (!isUuid(id)) throw notFound();
  const [row] = await getDb()
    .select()
    .from(overlayAudios)
    .where(and(eq(overlayAudios.id, id), eq(overlayAudios.ownerId, ownerId)))
    .limit(1);
  if (!row) throw notFound();
  return row;
}

export async function resolveSource(ownerId: string, projectId: string, s: { voiceId?: string | null; audioId?: string | null; fileId?: string | null }): Promise<ResolvedSource> {
  await getOwnedProject(ownerId, projectId);
  if (!s.fileId || !!s.voiceId === !!s.audioId) {
    throw new HttpError(422, 'VALIDATION', undefined, { source: 'Cần chọn đúng một nguồn voice và một tệp phụ đề' });
  }
  const file = await getOwnedFile(ownerId, s.fileId);
  if (file.projectId !== projectId) throw notFound();

  let kind: TimingSource;
  let durationMs: number;
  let voiceName: string;
  let timeline: Array<{ startMs: number; endMs: number; text?: string; failed?: boolean }> | null = null;
  if (s.voiceId) {
    const voice = await getOwnedVoice(ownerId, s.voiceId);
    if (voice.projectId !== projectId) throw notFound();
    const [job] = await getDb().select({ settings: voiceJobs.settings }).from(voiceJobs).where(eq(voiceJobs.id, voice.jobId));
    kind = voice.subtitleFileId !== file.id ? 'otherFile' : job?.settings.timing?.mode === 'timed' ? 'timed' : 'continuous';
    durationMs = voice.durationMs;
    voiceName = voice.title;
    timeline = voice.timeline;
  } else {
    const audio = await getOwnedOverlayAudio(ownerId, s.audioId!);
    if (audio.projectId !== projectId) throw notFound();
    if (audio.status !== 'ready' || !audio.durationMs) throw new HttpError(409, 'AUDIO_NOT_READY');
    kind = 'uploaded';
    durationMs = audio.durationMs;
    voiceName = audio.originalName;
  }
  if (!file.hasTimecodes) {
    throw new HttpError(409, 'NO_TIMECODES', 'Tệp này không có mốc thời gian hợp lệ nên không dùng làm phụ đề được. Hãy chọn tệp .srt có mốc thời gian.');
  }

  const fileCues = await getDb()
    .select({ startMs: subtitleCues.startMs, endMs: subtitleCues.endMs, text: subtitleCues.text, speakable: subtitleCues.speakable })
    .from(subtitleCues)
    .where(eq(subtitleCues.subtitleFileId, file.id))
    .orderBy(asc(subtitleCues.idx));
  const { cues, warnings } = applyTiming({ fileCues, source: kind, voiceTimeline: timeline, voiceDurationMs: durationMs });
  return {
    kind,
    voiceId: s.voiceId ?? null,
    audioId: s.audioId ?? null,
    fileId: file.id,
    names: { voice: voiceName, subtitle: file.originalName },
    durationMs,
    cues,
    warnings,
  };
}

// ---- Tạo tiến trình xuất ------------------------------------------------------------------------

const ADMISSION_LOCK = 727_005;

/** Kiểm giới hạn tiến trình và hạn mức (gọi trong giao dịch đã giữ khóa theo User). `exclude` bỏ qua chính tiến trình đang chạy lại. */
async function assertAdmission(tx: Db, ownerId: string, estimate: number, settings: Settings): Promise<void> {
  const [c] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(overlayJobs)
    .where(and(eq(overlayJobs.ownerId, ownerId), inArray(overlayJobs.status, [...OVERLAY_ACTIVE_STATUSES])));
  if ((c?.n ?? 0) >= settings.maxOverlayJobsPerUser) throw new HttpError(429, 'OVERLAY_TOO_MANY_JOBS');
  const used = await usedBytesOf(ownerId, tx);
  const pending = await pendingBytes(ownerId, tx);
  const remaining = Math.max(0, settings.userQuotaBytes - used - pending);
  if (estimate > remaining) {
    throw new HttpError(409, 'QUOTA_EXCEEDED', 'Không đủ dung lượng lưu trữ cho video này. Hãy xóa bớt video, tệp âm thanh hoặc voice rồi thử lại.', {
      needBytes: String(estimate - remaining),
      remainingBytes: String(remaining),
      estimateBytes: String(estimate),
    });
  }
}

export async function createOverlayJob(user: { id: string }, projectId: string, raw: unknown): Promise<{ job: OverlayJobDto; created: boolean }> {
  await getOwnedProject(user.id, projectId);
  const body = createSchema.parse(raw);
  const config = parseConfig(body.config);
  const db = getDb();

  const findExisting = async (tx: Db) => {
    const [row] = await tx
      .select(JOB_COLUMNS)
      .from(overlayJobs)
      .where(and(eq(overlayJobs.ownerId, user.id), eq(overlayJobs.clientRequestId, body.clientRequestId)));
    if (row && row.projectId !== projectId) throw new HttpError(409, 'CONFLICT');
    return row;
  };
  const before = await findExisting(db);
  if (before) return { job: overlayJobDto(before), created: false };

  const src = await resolveSource(user.id, projectId, body);
  const settings = await getSettings();
  const maxMinutes = isTransparent(config) ? settings.overlayMaxMinutesTransparent : settings.overlayMaxMinutes;
  if (src.durationMs > maxMinutes * 60_000) {
    throw new HttpError(422, 'OVERLAY_TOO_LONG', undefined, { maxMinutes: String(maxMinutes) });
  }
  if (src.cues.length === 0) throw new HttpError(422, 'OVERLAY_NO_CUES');

  const estimate = estimateBytes(config, src.durationMs);
  const size = sizeOf(config);
  const { row, created } = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${ADMISSION_LOCK}, hashtext(${user.id}))`);
    const again = await findExisting(tx as unknown as Db);
    if (again) return { row: again, created: false };
    await assertAdmission(tx as unknown as Db, user.id, estimate, settings);
    const [r] = await tx
      .insert(overlayJobs)
      .values({
        projectId,
        ownerId: user.id,
        clientRequestId: body.clientRequestId,
        voiceId: src.voiceId,
        audioId: src.audioId,
        subtitleFileId: src.fileId,
        sourceNames: src.names,
        config,
        cues: src.cues,
        engineVersion: ENGINE_VERSION,
        format: config.format,
        width: size.width,
        height: size.height,
        durationMs: src.durationMs,
        estimatedBytes: estimate,
        warnings: [...src.warnings, ...colorWarnings(config)],
      })
      .returning(JOB_COLUMNS);
    return { row: r!, created: true };
  });
  if (!created) return { job: overlayJobDto(row), created: false };

  await appendOverlayLog(row.id, 'info', 'queued');
  try {
    await enqueueRenderOverlay(row.id);
  } catch {
    await db.delete(overlayJobs).where(eq(overlayJobs.id, row.id));
    throw new HttpError(503, 'INTERNAL', 'Hệ thống tạm thời chưa nhận được việc mới. Hãy thử lại sau ít phút.');
  }
  return { job: overlayJobDto(row), created: true };
}

// ---- Đọc ----------------------------------------------------------------------------------------

export async function getOwnedOverlayJob(ownerId: string, id: string): Promise<JobListRow> {
  if (!isUuid(id)) throw notFound();
  const [row] = await getDb()
    .select(JOB_COLUMNS)
    .from(overlayJobs)
    .where(and(eq(overlayJobs.id, id), eq(overlayJobs.ownerId, ownerId)))
    .limit(1);
  if (!row) throw notFound();
  return row;
}

export async function listOverlayJobs(ownerId: string, projectId: string): Promise<OverlayJobDto[]> {
  await getOwnedProject(ownerId, projectId);
  const rows = await getDb()
    .select(JOB_COLUMNS)
    .from(overlayJobs)
    .where(and(eq(overlayJobs.projectId, projectId), eq(overlayJobs.ownerId, ownerId)))
    .orderBy(desc(overlayJobs.createdAt))
    .limit(50);
  return rows.map(overlayJobDto);
}

export type OverlayLogDto = { id: number; ts: string; level: 'info' | 'warn' | 'error'; messageKey: string; params: Record<string, string | number> | null };

/** Chi tiết + 50 dòng nhật ký gần nhất (FR-039). */
export async function getOverlayJobDetail(ownerId: string, id: string): Promise<OverlayJobDto & { logs: OverlayLogDto[] }> {
  const row = await getOwnedOverlayJob(ownerId, id);
  const logs = await getDb().select().from(overlayJobLogs).where(eq(overlayJobLogs.jobId, row.id)).orderBy(desc(overlayJobLogs.id)).limit(50);
  return {
    ...overlayJobDto(row),
    logs: logs.reverse().map((l) => ({ id: l.id, ts: l.ts.toISOString(), level: l.level, messageKey: l.messageKey, params: l.params ?? null })),
  };
}

// ---- Dừng, chạy lại, xóa ------------------------------------------------------------------------

export async function stopOverlayJob(ownerId: string, id: string): Promise<{ status: string }> {
  const row = await getOwnedOverlayJob(ownerId, id);
  const r = await requestStopOverlay(ownerId, [row.id]);
  if (r.stopped.length > 0) return { status: 'stopped' };
  if (r.stopRequested.length > 0) return { status: 'stopping' };
  throw new HttpError(409, 'CONFLICT');
}

/** Chạy lại tiến trình lỗi hoặc đã dừng với nội dung đã chốt (FR-042). */
export async function rerunOverlayJob(ownerId: string, id: string): Promise<OverlayJobDto> {
  const row = await getOwnedOverlayJob(ownerId, id);
  if (row.status !== 'failed' && row.status !== 'stopped') throw new HttpError(409, 'CONFLICT');
  if (!hasSources(row)) throw new HttpError(409, 'SOURCE_DELETED');
  const settings = await getSettings();
  const maxMinutes = isTransparent(row.config) ? settings.overlayMaxMinutesTransparent : settings.overlayMaxMinutes;
  if (row.durationMs > maxMinutes * 60_000) throw new HttpError(422, 'OVERLAY_TOO_LONG', undefined, { maxMinutes: String(maxMinutes) });
  const next = await getDb().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${ADMISSION_LOCK}, hashtext(${ownerId}))`);
    await assertAdmission(tx as unknown as Db, ownerId, row.estimatedBytes, settings);
    const [r] = await tx
      .update(overlayJobs)
      .set({ status: 'queued', progressPercent: 0, errorCode: null, cancelRequested: false, interruptions: 0, heartbeatAt: null, startedAt: null, finishedAt: null })
      .where(and(eq(overlayJobs.id, id), eq(overlayJobs.ownerId, ownerId), inArray(overlayJobs.status, ['failed', 'stopped'])))
      .returning(JOB_COLUMNS);
    return r;
  });
  if (!next) throw new HttpError(409, 'CONFLICT');
  await appendOverlayLog(id, 'info', 'rerun');
  try {
    await enqueueRenderOverlay(id);
  } catch {
    await getDb().update(overlayJobs).set({ status: 'failed', errorCode: 'INTERNAL', finishedAt: new Date() }).where(eq(overlayJobs.id, id));
    throw new HttpError(503, 'INTERNAL', 'Hệ thống tạm thời chưa nhận được việc mới. Hãy thử lại sau ít phút.');
  }
  return overlayJobDto(next);
}

export type BulkDeleteResult = { deleted: string[]; busy: string[]; notFound: string[] };

/** Xóa một hoặc nhiều lần xuất; tiến trình đang chạy được dừng trước. Trả lại hạn mức ngay (FR-043). */
export async function deleteOverlayJobs(ownerId: string, ids: string[], opts: { waitMs?: number } = {}): Promise<BulkDeleteResult> {
  const db = getDb();
  const valid = ids.filter(isUuid);
  const rows = valid.length ? await db.select(JOB_COLUMNS).from(overlayJobs).where(and(eq(overlayJobs.ownerId, ownerId), inArray(overlayJobs.id, valid))) : [];
  const found = new Set(rows.map((r) => r.id));
  const result: BulkDeleteResult = { deleted: [], busy: [], notFound: ids.filter((id) => !found.has(id)) };
  const active = rows.filter((r) => (OVERLAY_ACTIVE_STATUSES as readonly string[]).includes(r.status)).map((r) => r.id);
  if (active.length > 0) {
    await requestStopOverlay(ownerId, active);
    result.busy = await waitOverlayNotRunning(active, opts.waitMs);
  }
  for (const r of rows) {
    if (result.busy.includes(r.id)) continue;
    const [gone] = await db
      .delete(overlayJobs)
      .where(and(eq(overlayJobs.id, r.id), eq(overlayJobs.ownerId, ownerId)))
      .returning({ key: overlayJobs.outputStorageKey, size: overlayJobs.outputSizeBytes });
    if (!gone) continue;
    if (gone.key && gone.size) await purgeObjects(ownerId, [{ key: gone.key, size: gone.size }]);
    else await deleteOverlayObject({ id: r.id, ownerId, format: r.format });
    result.deleted.push(r.id);
  }
  return result;
}

export const VIDEO_CONTENT_TYPE: Record<JobRow['format'], string> = { mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm' };

/** Tên tệp tải về: tên phụ đề bỏ đuôi, làm sạch ký tự đặc biệt. */
export function videoFileName(r: Pick<JobRow, 'sourceNames' | 'format'>): string {
  const base = r.sourceNames.subtitle.replace(/\.[a-z0-9]{1,5}$/i, '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').trim().slice(0, 150);
  return `${base || 'video'}-overlay.${r.format}`;
}
