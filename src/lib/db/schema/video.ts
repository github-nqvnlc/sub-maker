import { sql } from 'drizzle-orm';
import { bigint, bigserial, boolean, check, index, integer, jsonb, pgEnum, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import type { VideoStyle } from '../../video/style';
import type {
  CueFlags,
  CueTiming,
  Direction,
  ExportFormat,
  ExportKind,
  GlossaryPair,
  PreviewState,
  SourceState,
  UploadKind,
  UploadState,
  Cue,
  VideoExtension,
  VideoMedia,
} from '../../video/types';
import { users } from './auth';
import { logLevel } from './jobs';
import { projects } from './projects';

/**
 * Dịch video tự động và gắn đè phụ đề (spec 006, data-model §1). Mọi bảng có chủ mang `owner_id`; mọi truy vấn của người dùng lọc
 * theo `owner_id`, sai thì 404. Dung lượng dùng `bigint`.
 */

export const videoJobStatus = pgEnum('video_job_status', [
  'waiting_media',
  'queued',
  'preparing',
  'translating',
  'segmenting',
  'review_ready',
  'failed',
  'stopped',
  'interrupted',
]);
export type VideoJobStatus = (typeof videoJobStatus.enumValues)[number];
/** Pipeline đang chạy (worker đang giữ hoặc sẽ nhận): dừng được. */
export const VIDEO_PIPELINE_ACTIVE = ['queued', 'preparing', 'translating', 'segmenting', 'interrupted'] as const;
export const VIDEO_PIPELINE_RUNNING = ['preparing', 'translating', 'segmenting'] as const;

export const videoExportStatus = pgEnum('video_export_status', ['queued', 'running', 'completed', 'failed', 'stopped', 'interrupted', 'expired']);
export type VideoExportStatus = (typeof videoExportStatus.enumValues)[number];
export const VIDEO_EXPORT_ACTIVE = ['queued', 'running', 'interrupted'] as const;

/** Cài đặt dịch video của Project (FR-019, FR-031). */
export const videoProjectSettings = pgTable(
  'video_project_settings',
  {
    projectId: uuid('project_id')
      .primaryKey()
      .references(() => projects.id, { onDelete: 'cascade' }),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    direction: text('direction').$type<Direction>().notNull().default('to_vi'),
    glossary: jsonb('glossary').$type<GlossaryPair[]>().notNull().default(sql`'[]'::jsonb`),
    /** kiểu gần nhất; NULL = mặc định */
    style: jsonb('style').$type<VideoStyle>(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check('video_project_settings_direction', sql`${t.direction} in ('to_vi','vi_to_en')`)],
);

/** Một lần làm việc với một video (data-model §1.2). */
export const videoJobs = pgTable(
  'video_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    originalFileName: text('original_file_name').notNull(),
    ext: text('ext').$type<VideoExtension>().notNull(),
    fileSizeBytes: bigint('file_size_bytes', { mode: 'number' }).notNull(),
    /** nhận diện đúng tệp khi tải tiếp và tải lại (research R7) */
    fingerprint: text('fingerprint').notNull(),
    direction: text('direction').$type<Direction>().notNull(),
    /** bản chụp từ điển đã dùng (FR-021) */
    glossary: jsonb('glossary').$type<GlossaryPair[]>().notNull().default(sql`'[]'::jsonb`),
    clientAudio: boolean('client_audio').notNull().default(false),
    /** âm thanh trình duyệt lệch nguồn, chờ xác nhận dịch lại (FR-011) */
    audioMismatch: boolean('audio_mismatch').notNull().default(false),
    sourceState: text('source_state').$type<SourceState>().notNull().default('uploading'),
    sourceKey: text('source_key'),
    /** chỉ `recomputeSourceExpiry` được ghi (data-model §5) */
    sourceExpiresAt: timestamp('source_expires_at', { withTimezone: true }),
    /** lượt phát đang dùng video nguồn */
    sourceLeaseUntil: timestamp('source_lease_until', { withTimezone: true }),
    media: jsonb('media').$type<VideoMedia>(),
    audioTempKey: text('audio_temp_key'),
    previewState: text('preview_state').$type<PreviewState>().notNull().default('none'),
    previewKey: text('preview_key'),
    previewBytes: bigint('preview_bytes', { mode: 'number' }),
    previewHeartbeatAt: timestamp('preview_heartbeat_at', { withTimezone: true }),
    previewAttempt: integer('preview_attempt').notNull().default(0),
    status: videoJobStatus('status').notNull().default('waiting_media'),
    /** 0–50 cho pipeline dịch (FR-049) */
    progressPercent: integer('progress_percent').notNull().default(0),
    stageKey: text('stage_key'),
    errorCode: text('error_code'),
    cancelRequested: boolean('cancel_requested').notNull().default(false),
    attempt: integer('attempt').notNull().default(0),
    /** số lần gián đoạn trong lượt chạy hiện tại; về 0 khi chạy lại */
    interruptions: integer('interruptions').notNull().default(0),
    heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }),
    sonioxFileId: text('soniox_file_id'),
    sonioxTranscriptionId: text('soniox_transcription_id'),
    model: text('model'),
    /** tăng khi "Dịch lại" */
    translationRun: integer('translation_run').notNull().default(1),
    /** lượt đã ghi bản ghi tính phí: chạy lại không ghi lần hai (FR-016) */
    billedRun: integer('billed_run').notNull().default(0),
    /** lượt mà cue đang lưu thuộc về (0 = chưa có cue) */
    cueRun: integer('cue_run').notNull().default(0),
    cueRevision: integer('cue_revision').notNull().default(0),
    cueCount: integer('cue_count').notNull().default(0),
    /** chữ phụ đề trong CSDL, tính vào hạn mức 500 MB (FR-055) */
    scriptBytes: bigint('script_bytes', { mode: 'number' }).notNull().default(0),
    style: jsonb('style').$type<VideoStyle>(),
    lastActivityAt: timestamp('last_activity_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('video_jobs_project_idx').on(t.projectId, t.createdAt),
    index('video_jobs_owner_status_idx').on(t.ownerId, t.status),
    index('video_jobs_status_heartbeat_idx').on(t.status, t.heartbeatAt),
    index('video_jobs_source_expires_idx').on(t.sourceExpiresAt),
    check('video_jobs_name_len', sql`char_length(${t.originalFileName}) between 1 and 255`),
    check('video_jobs_ext', sql`${t.ext} in ('mp4','mov','mkv','webm','avi','flv','m4v')`),
    check('video_jobs_size_pos', sql`${t.fileSizeBytes} >= 1`),
    check('video_jobs_direction', sql`${t.direction} in ('to_vi','vi_to_en')`),
    check('video_jobs_source_state', sql`${t.sourceState} in ('uploading','checking','ready','deleted','rejected')`),
    check('video_jobs_preview_state', sql`${t.previewState} in ('none','pending','ready','failed')`),
    check('video_jobs_progress_range', sql`${t.progressPercent} between 0 and 50`),
    check('video_jobs_script_nonneg', sql`${t.scriptBytes} >= 0`),
    check('video_jobs_cue_count_range', sql`${t.cueCount} between 0 and 20000`),
  ],
);

/** Phiên tải lên từng phần (data-model §1.3). */
export const videoUploads = pgTable(
  'video_uploads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => videoJobs.id, { onDelete: 'cascade' }),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<UploadKind>().notNull(),
    storageUploadId: text('storage_upload_id').notNull(),
    key: text('key').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    partSize: integer('part_size').notNull(),
    partCount: integer('part_count').notNull(),
    fingerprint: text('fingerprint').notNull(),
    state: text('state').$type<UploadState>().notNull().default('active'),
    /** 48 giờ sau phần gần nhất */
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /** mỗi (việc, loại) nhiều nhất một phiên đang mở */
    uniqueIndex('video_uploads_open_uq')
      .on(t.jobId, t.kind)
      .where(sql`${t.state} in ('active','completing')`),
    index('video_uploads_owner_state_idx').on(t.ownerId, t.state),
    index('video_uploads_state_expires_idx').on(t.state, t.expiresAt),
    check('video_uploads_kind', sql`${t.kind} in ('source','client_audio')`),
    check('video_uploads_state', sql`${t.state} in ('active','completing','completed','aborted')`),
    check('video_uploads_size_pos', sql`${t.sizeBytes} >= 1`),
    check('video_uploads_parts_range', sql`${t.partCount} between 1 and 10000 and ${t.partSize} > 0`),
  ],
);

export const videoUploadParts = pgTable(
  'video_upload_parts',
  {
    uploadId: uuid('upload_id')
      .notNull()
      .references(() => videoUploads.id, { onDelete: 'cascade' }),
    n: integer('n').notNull(),
    size: integer('size').notNull(),
    etag: text('etag').notNull(),
    sha256: text('sha256').notNull(),
  },
  (t) => [primaryKey({ columns: [t.uploadId, t.n], name: 'video_upload_parts_pk' }), check('video_upload_parts_n', sql`${t.n} between 1 and 10000`)],
);

/** Cue của một việc (data-model §1.4). Thứ tự theo `start_ms`; không chồng nhau (kiểm trong giao dịch). */
export const videoCues = pgTable(
  'video_cues',
  {
    /** id có thể do trình duyệt sinh (hoàn tác) nên khóa chính kèm việc: không đụng được việc khác */
    id: uuid('id').notNull().defaultRandom(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => videoJobs.id, { onDelete: 'cascade' }),
    startMs: integer('start_ms').notNull(),
    endMs: integer('end_ms').notNull(),
    timing: text('timing').$type<CueTiming>().notNull(),
    sourceText: text('source_text').notNull().default(''),
    targetText: text('target_text').notNull().default(''),
    sourceLang: text('source_lang'),
    speaker: text('speaker'),
    flags: jsonb('flags').$type<CueFlags>().notNull().default(sql`'{}'::jsonb`),
  },
  (t) => [
    primaryKey({ columns: [t.jobId, t.id], name: 'video_cues_pk' }),
    index('video_cues_job_start_idx').on(t.jobId, t.startMs),
    check('video_cues_time', sql`${t.startMs} >= 0 and ${t.endMs} - ${t.startMs} >= 100`),
    check('video_cues_timing', sql`${t.timing} in ('measured','estimated','manual')`),
    check('video_cues_text_len', sql`char_length(${t.sourceText}) <= 2000 and char_length(${t.targetText}) <= 2000`),
  ],
);

/** Bản xuất (data-model §1.5). */
export const videoExports = pgTable(
  'video_exports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => videoJobs.id, { onDelete: 'cascade' }),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<ExportKind>().notNull(),
    format: text('format').$type<ExportFormat>().notNull(),
    /** chốt lúc bấm xuất (FR-042) */
    style: jsonb('style').$type<VideoStyle>().notNull(),
    cues: jsonb('cues').$type<Cue[]>().notNull(),
    cueRevision: integer('cue_revision').notNull(),
    status: videoExportStatus('status').notNull().default('queued'),
    /** 50–100 (FR-049) */
    progressPercent: integer('progress_percent').notNull().default(50),
    estimatedBytes: bigint('estimated_bytes', { mode: 'number' }).notNull(),
    outputBytes: bigint('output_bytes', { mode: 'number' }),
    outputKey: text('output_key'),
    durationMs: integer('duration_ms').notNull(),
    errorCode: text('error_code'),
    cancelRequested: boolean('cancel_requested').notNull().default(false),
    attempt: integer('attempt').notNull().default(0),
    interruptions: integer('interruptions').notNull().default(0),
    heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }),
    /** tạo xong + số ngày giữ */
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    downloadLeaseUntil: timestamp('download_lease_until', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    /** một việc nhiều nhất một bản đang chờ, đang chạy hoặc bị gián đoạn */
    uniqueIndex('video_exports_open_uq')
      .on(t.jobId)
      .where(sql`${t.status} in ('queued','running','interrupted')`),
    index('video_exports_job_idx').on(t.jobId, t.createdAt),
    index('video_exports_owner_status_idx').on(t.ownerId, t.status),
    index('video_exports_status_heartbeat_idx').on(t.status, t.heartbeatAt),
    index('video_exports_status_expires_idx').on(t.status, t.expiresAt),
    check('video_exports_kind', sql`${t.kind} in ('burn','layer')`),
    check('video_exports_format', sql`${t.format} in ('mp4','mov') and (${t.kind} <> 'burn' or ${t.format} = 'mp4')`),
    check('video_exports_progress_range', sql`${t.progressPercent} between 50 and 100`),
    check('video_exports_estimate_pos', sql`${t.estimatedBytes} > 0`),
    check('video_exports_duration_pos', sql`${t.durationMs} > 0`),
    check('video_exports_output_pos', sql`${t.outputBytes} is null or ${t.outputBytes} > 0`),
    check('video_exports_completed_has_output', sql`${t.status} <> 'completed' or (${t.outputKey} is not null and ${t.outputBytes} is not null and ${t.expiresAt} is not null)`),
  ],
);

/** Nhật ký (data-model §1.6): khóa i18n + tham số, không chứa khóa, URL ký hay đường dẫn máy chủ. */
export const videoJobLogs = pgTable(
  'video_job_logs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => videoJobs.id, { onDelete: 'cascade' }),
    exportId: uuid('export_id').references(() => videoExports.id, { onDelete: 'cascade' }),
    ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
    level: logLevel('level').notNull(),
    /** khóa i18n trong `video.log.*` */
    messageKey: text('message_key').notNull(),
    params: jsonb('params').$type<Record<string, string | number>>(),
  },
  (t) => [index('video_job_logs_job_idx').on(t.jobId, t.id)],
);
