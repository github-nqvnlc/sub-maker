import { boolean, index, integer, jsonb, pgEnum, pgTable, primaryKey, text, timestamp, bigserial, uniqueIndex, uuid, numeric } from 'drizzle-orm/pg-core';
import { users } from './auth';
import { aiProviderConfigs, configScope, providerType } from './ai-config';
import { projects, subtitleFiles } from './projects';

export const jobStatus = pgEnum('job_status', ['queued', 'running', 'completed', 'failed', 'stopped', 'interrupted']);
export const jobSegmentStatus = pgEnum('job_segment_status', ['pending', 'running', 'done', 'failed']);
export const logLevel = pgEnum('log_level', ['info', 'warn', 'error']);

export type JobSettings = {
  model?: string | null;
  voice: string;
  speed?: number | null;
  maxCharsPerSegment?: number;
  pauseMs?: { sentence: number; comma: number };
};

/** Audio từng đoạn (PCM chuẩn hóa), cache THEO USER, khóa theo hash nội dung (R7). */
export const audioCache = pgTable(
  'audio_cache',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** sha256(userId | providerType | model | voice | speed | format | textNFC) */
    contentHash: text('content_hash').notNull(),
    storageKey: text('storage_key').notNull(),
    durationMs: integer('duration_ms').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    chars: integer('chars').notNull(),
    providerType: providerType('provider_type').notNull(),
    model: text('model'),
    voice: text('voice').notNull(),
    speed: numeric('speed', { mode: 'number' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('audio_cache_owner_hash_uq').on(t.ownerId, t.contentHash)],
);

export const voiceJobs = pgTable(
  'voice_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    subtitleFileId: uuid('subtitle_file_id')
      .notNull()
      .references(() => subtitleFiles.id, { onDelete: 'cascade' }),
    status: jobStatus('status').notNull().default('queued'),
    providerType: providerType('provider_type').notNull(),
    /** Cấu hình đã dùng lúc bắt đầu (NULL nếu cấu hình bị xóa sau đó) */
    configId: uuid('config_id').references(() => aiProviderConfigs.id, { onDelete: 'set null' }),
    /** Nguồn cấu hình: chung (chi phí hệ thống) hoặc riêng (chi phí của User) */
    configScope: configScope('config_scope').notNull(),
    settings: jsonb('settings').$type<JobSettings>().notNull(),
    progressDone: integer('progress_done').notNull().default(0),
    progressTotal: integer('progress_total').notNull().default(0),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    cancelRequested: boolean('cancel_requested').notNull().default(false),
    attempt: integer('attempt').notNull().default(0),
    heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }),
    queueJobId: text('queue_job_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    index('voice_jobs_project_idx').on(t.projectId, t.createdAt),
    index('voice_jobs_owner_status_idx').on(t.ownerId, t.status),
    index('voice_jobs_status_heartbeat_idx').on(t.status, t.heartbeatAt),
  ],
);

export const jobSegments = pgTable(
  'job_segments',
  {
    jobId: uuid('job_id')
      .notNull()
      .references(() => voiceJobs.id, { onDelete: 'cascade' }),
    idx: integer('idx').notNull(),
    status: jobSegmentStatus('status').notNull().default('pending'),
    cacheHit: boolean('cache_hit').notNull().default(false),
    audioCacheId: uuid('audio_cache_id').references(() => audioCache.id, { onDelete: 'set null' }),
    durationMs: integer('duration_ms'),
    attempts: integer('attempts').notNull().default(0),
    /** ví dụ CONTENT_BLOCKED, QUOTA, TIMEOUT */
    errorCode: text('error_code'),
  },
  (t) => [primaryKey({ columns: [t.jobId, t.idx] }), index('job_segments_cache_idx').on(t.audioCacheId)],
);

/** Dòng log tiến trình. `id` tăng dần dùng làm con trỏ SSE / Last-Event-ID. Không chứa khóa API. */
export const jobLogs = pgTable(
  'job_logs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => voiceJobs.id, { onDelete: 'cascade' }),
    ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
    level: logLevel('level').notNull(),
    code: text('code').notNull(),
    message: text('message').notNull(),
    meta: jsonb('meta').$type<Record<string, unknown>>(),
  },
  (t) => [index('job_logs_job_id_idx').on(t.jobId, t.id)],
);

export type TimelineEntry = { idx: number; startMs: number; endMs: number };

export const voices = pgTable(
  'voices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Mỗi job hoàn tất cho đúng một voice */
    jobId: uuid('job_id')
      .notNull()
      .references(() => voiceJobs.id, { onDelete: 'cascade' }),
    subtitleFileId: uuid('subtitle_file_id')
      .notNull()
      .references(() => subtitleFiles.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    storageKey: text('storage_key').notNull(),
    format: text('format').notNull().default('mp3'),
    durationMs: integer('duration_ms').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    /** [{ idx, startMs, endMs }], chính xác theo số mẫu PCM */
    timeline: jsonb('timeline').$type<TimelineEntry[]>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('voices_job_uq').on(t.jobId), index('voices_project_idx').on(t.projectId, t.createdAt)],
);
