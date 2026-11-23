import { bigserial, boolean, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './auth';
import { logLevel } from './jobs';
import { projects, subtitleFiles } from './projects';

/**
 * Tiến trình chuyển giọng nói thành phụ đề (spec 004, data-model §1).
 * Trạng thái "đang chờ/đang chạy" (đếm theo `maxSttJobsPerUser`): mọi trạng thái trừ `completed` và `failed`.
 */
export const sttJobStatus = pgEnum('stt_job_status', [
  'queued',
  'extracting',
  'uploading',
  'transcribing',
  'formatting',
  'completed',
  'failed',
  'interrupted',
]);

export const STT_ACTIVE_STATUSES = ['queued', 'extracting', 'uploading', 'transcribing', 'formatting', 'interrupted'] as const;
export const STT_RUNNING_STATUSES = ['extracting', 'uploading', 'transcribing', 'formatting'] as const;
export type SttJobStatus = (typeof sttJobStatus.enumValues)[number];
export type SttTargetFormat = 'srt' | 'txt' | 'md';

export const sttJobs = pgTable(
  'stt_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    originalFileName: text('original_file_name').notNull(),
    /** 'audio' | 'video' */
    mediaType: text('media_type').$type<'audio' | 'video'>().notNull(),
    fileSizeBytes: integer('file_size_bytes').notNull(),
    /** users/{userId}/stt-tmp/{jobId}/source.{ext} — NULL sau khi đã dọn */
    tempStorageKey: text('temp_storage_key'),
    targetFormat: text('target_format').$type<SttTargetFormat>().notNull().default('srt'),
    targetFileName: text('target_file_name').notNull(),
    /** 'auto' hoặc mã ngôn ngữ gợi ý (FR-016) */
    language: text('language').notNull().default('auto'),
    enableDiarization: boolean('enable_diarization').notNull().default(false),
    status: sttJobStatus('status').notNull().default('queued'),
    progressPercent: integer('progress_percent').notNull().default(0),
    /** khóa i18n của giai đoạn hiện tại */
    stageMessage: text('stage_message'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    sonioxFileId: text('soniox_file_id'),
    sonioxTranscriptionId: text('soniox_transcription_id'),
    /** Thời lượng âm thanh do Soniox trả về (ms); không tự tính */
    audioDurationMs: integer('audio_duration_ms'),
    /** Model đã dùng (chốt lúc gửi Soniox) */
    model: text('model'),
    resultSubtitleFileId: uuid('result_subtitle_file_id').references(() => subtitleFiles.id, { onDelete: 'set null' }),
    attempt: integer('attempt').notNull().default(0),
    heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('stt_jobs_project_idx').on(t.projectId, t.createdAt),
    index('stt_jobs_owner_status_idx').on(t.ownerId, t.status),
    index('stt_jobs_status_heartbeat_idx').on(t.status, t.heartbeatAt),
  ],
);

/** Nhật ký chi tiết của STT job (FR-020). Không chứa khóa API hay URL có khóa. */
export const sttJobLogs = pgTable(
  'stt_job_logs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    sttJobId: uuid('stt_job_id')
      .notNull()
      .references(() => sttJobs.id, { onDelete: 'cascade' }),
    ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
    level: logLevel('level').notNull(),
    /** khóa i18n trong `stt.log.*` */
    messageKey: text('message_key').notNull(),
    params: jsonb('params').$type<Record<string, string | number>>(),
  },
  (t) => [index('stt_job_logs_job_ts_idx').on(t.sttJobId, t.id)],
);
