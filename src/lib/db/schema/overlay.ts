import { sql } from 'drizzle-orm';
import { bigint, bigserial, boolean, check, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import type { OverlayConfig, OverlayFormat } from '../../overlay/config';
import type { AppliedCue, OverlayWarning } from '../../overlay/types';
import { users } from './auth';
import { jobStatus, logLevel, voices } from './jobs';
import { projects, subtitleFiles } from './projects';

/** Video overlay phụ đề (spec 005, data-model). Mọi truy vấn kèm `owner_id` lấy từ phiên. */

export const overlayAudioStatus = pgEnum('overlay_audio_status', ['processing', 'ready', 'failed']);
export const overlayFormat = pgEnum('overlay_format', ['mp4', 'mov', 'webm']);

/** Trạng thái "đang hoạt động": tính vào giới hạn mỗi User và giữ chỗ hạn mức (FR-040, FR-044). */
export const OVERLAY_ACTIVE_STATUSES = ['queued', 'running', 'interrupted'] as const;

export type OverlaySource = { voiceId?: string | null; audioId?: string | null; fileId?: string | null };

/** Cấu hình gần nhất của mỗi Project (FR-016). */
export const overlayConfigs = pgTable('overlay_configs', {
  projectId: uuid('project_id')
    .primaryKey()
    .references(() => projects.id, { onDelete: 'cascade' }),
  ownerId: uuid('owner_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  config: jsonb('config').$type<OverlayConfig>().notNull(),
  /** chỉ để mở lại màn hình; id không còn thì bỏ qua */
  source: jsonb('source').$type<OverlaySource>().notNull().default(sql`'{}'::jsonb`),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Tệp âm thanh người dùng tải lên cho overlay (FR-002, FR-043). */
export const overlayAudios = pgTable(
  'overlay_audios',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    originalName: text('original_name').notNull(),
    status: overlayAudioStatus('status').notNull().default('processing'),
    /** users/{u}/overlay-tmp/{id}/source.{ext} — NULL sau khi đã dọn */
    tempStorageKey: text('temp_storage_key'),
    storageKey: text('storage_key'),
    /** dung lượng thật của MP3 đã chuẩn hóa, tính vào hạn mức */
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull().default(0),
    durationMs: integer('duration_ms'),
    errorCode: text('error_code'),
    interruptions: integer('interruptions').notNull().default(0),
    heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('overlay_audios_project_idx').on(t.projectId, t.createdAt),
    index('overlay_audios_owner_status_idx').on(t.ownerId, t.status),
    check('overlay_audios_name_len', sql`char_length(${t.originalName}) between 1 and 255`),
    check('overlay_audios_size_nonneg', sql`${t.sizeBytes} >= 0`),
    check('overlay_audios_duration_pos', sql`${t.durationMs} is null or ${t.durationMs} > 0`),
    check('overlay_audios_ready', sql`${t.status} <> 'ready' or (${t.durationMs} is not null and ${t.storageKey} is not null)`),
  ],
);

/** Một lần xuất video; video thành phẩm là 1–1 với tiến trình nên nằm cùng dòng (FR-035..044). */
export const overlayJobs = pgTable(
  'overlay_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** chống bấm trùng: gửi lại cùng id thì trả dòng cũ */
    clientRequestId: uuid('client_request_id').notNull(),
    voiceId: uuid('voice_id').references(() => voices.id, { onDelete: 'set null' }),
    audioId: uuid('audio_id').references(() => overlayAudios.id, { onDelete: 'set null' }),
    subtitleFileId: uuid('subtitle_file_id').references(() => subtitleFiles.id, { onDelete: 'set null' }),
    /** tên nguồn lúc xuất, còn hiển thị được sau khi nguồn bị xóa */
    sourceNames: jsonb('source_names').$type<{ voice: string; subtitle: string }>().notNull(),
    config: jsonb('config').$type<OverlayConfig>().notNull(),
    cues: jsonb('cues').$type<AppliedCue[]>().notNull(),
    engineVersion: integer('engine_version').notNull(),
    format: overlayFormat('format').$type<OverlayFormat>().notNull(),
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    durationMs: integer('duration_ms').notNull(),
    estimatedBytes: bigint('estimated_bytes', { mode: 'number' }).notNull(),
    /** cảnh báo về mốc và màu do máy chủ tính lúc tạo */
    warnings: jsonb('warnings').$type<OverlayWarning[]>().notNull().default(sql`'[]'::jsonb`),
    status: jobStatus('status').notNull().default('queued'),
    progressPercent: integer('progress_percent').notNull().default(0),
    errorCode: text('error_code'),
    cancelRequested: boolean('cancel_requested').notNull().default(false),
    /** tổng số lần nhận việc, chỉ để nhật ký */
    attempt: integer('attempt').notNull().default(0),
    /** số lần gián đoạn trong lượt chạy hiện tại; về 0 khi chạy lại */
    interruptions: integer('interruptions').notNull().default(0),
    heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    outputStorageKey: text('output_storage_key'),
    outputSizeBytes: bigint('output_size_bytes', { mode: 'number' }),
  },
  (t) => [
    uniqueIndex('overlay_jobs_owner_request_uq').on(t.ownerId, t.clientRequestId),
    index('overlay_jobs_project_idx').on(t.projectId, t.createdAt),
    index('overlay_jobs_owner_status_idx').on(t.ownerId, t.status),
    index('overlay_jobs_status_heartbeat_idx').on(t.status, t.heartbeatAt),
    index('overlay_jobs_status_created_idx').on(t.status, t.createdAt),
    index('overlay_jobs_voice_idx').on(t.voiceId),
    index('overlay_jobs_audio_idx').on(t.audioId),
    index('overlay_jobs_file_idx').on(t.subtitleFileId),
    check('overlay_jobs_duration_pos', sql`${t.durationMs} > 0`),
    check('overlay_jobs_estimate_pos', sql`${t.estimatedBytes} > 0`),
    check('overlay_jobs_progress_range', sql`${t.progressPercent} between 0 and 100`),
    check('overlay_jobs_output_pos', sql`${t.outputSizeBytes} is null or ${t.outputSizeBytes} > 0`),
    check(
      'overlay_jobs_completed_has_output',
      sql`(${t.status} = 'completed') = (${t.outputStorageKey} is not null and ${t.outputSizeBytes} is not null)`,
    ),
  ],
);

/** Nhật ký tiến trình xuất (FR-039): khóa i18n + tham số, không chứa bí mật hay đường dẫn nội bộ. */
export const overlayJobLogs = pgTable(
  'overlay_job_logs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => overlayJobs.id, { onDelete: 'cascade' }),
    ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
    level: logLevel('level').notNull(),
    /** khóa i18n trong `overlay.log.*` */
    messageKey: text('message_key').notNull(),
    params: jsonb('params').$type<Record<string, string | number>>(),
  },
  (t) => [index('overlay_job_logs_job_idx').on(t.jobId, t.id)],
);
