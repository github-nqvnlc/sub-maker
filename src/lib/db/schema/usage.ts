import { sql } from 'drizzle-orm';
import { bigserial, boolean, check, index, integer, jsonb, numeric, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './auth';
import { configScope, providerType } from './ai-config';
import { voiceJobs } from './jobs';
import { projects } from './projects';
import { sttJobs } from './stt-jobs';
import { videoJobs } from './video';

/**
 * Mỗi lần GỌI THẬT nhà cung cấp (cache hit không ghi). Ẩn danh hóa khi xóa User:
 * user_id/project_id/job_id đặt NULL để giữ số liệu tổng hợp (FR-037, FR-040, FR-045).
 */
export const usageRecords = pgTable(
  'usage_records',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
    jobId: uuid('job_id').references(() => voiceJobs.id, { onDelete: 'set null' }),
    /** STT job (spec 004); NULL với bản ghi TTS */
    sttJobId: uuid('stt_job_id').references(() => sttJobs.id, { onDelete: 'set null' }),
    /** Việc dịch video (spec 006) */
    videoJobId: uuid('video_job_id').references(() => videoJobs.id, { onDelete: 'set null' }),
    providerType: providerType('provider_type').notNull(),
    configScope: configScope('config_scope').notNull(),
    model: text('model'),
    voice: text('voice'),
    /** số ký tự Unicode thực gửi (TTS); NULL với bản ghi STT */
    unitsChars: integer('units_chars'),
    /** số giây âm thanh do nhà cung cấp STT trả về (spec 004); không tự tính */
    unitsAudioSeconds: integer('units_audio_seconds'),
    /** chỉ điền khi nhà cung cấp trả về; không bịa số */
    unitsTokens: integer('units_tokens'),
    costEstimateUsd: numeric('cost_estimate_usd', { mode: 'number' }),
    /** lần gọi thành công hay lỗi (lỗi không tính phí nhưng vẫn ghi để chẩn đoán) */
    ok: boolean('ok').notNull(),
  },
  (t) => [
    index('usage_user_ts_idx').on(t.userId, t.ts),
    index('usage_ts_idx').on(t.ts),
    check('usage_units_present', sql`${t.unitsChars} is not null or ${t.unitsAudioSeconds} is not null`),
  ],
);

export const systemSettings = pgTable('system_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').$type<unknown>().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
});
