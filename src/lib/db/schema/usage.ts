import { bigserial, boolean, index, integer, jsonb, numeric, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './auth';
import { configScope, providerType } from './ai-config';
import { voiceJobs } from './jobs';
import { projects } from './projects';

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
    providerType: providerType('provider_type').notNull(),
    configScope: configScope('config_scope').notNull(),
    model: text('model'),
    voice: text('voice'),
    /** số ký tự Unicode thực gửi */
    unitsChars: integer('units_chars').notNull(),
    /** chỉ điền khi nhà cung cấp trả về; không bịa số */
    unitsTokens: integer('units_tokens'),
    costEstimateUsd: numeric('cost_estimate_usd', { mode: 'number' }),
    /** lần gọi thành công hay lỗi (lỗi không tính phí nhưng vẫn ghi để chẩn đoán) */
    ok: boolean('ok').notNull(),
  },
  (t) => [index('usage_user_ts_idx').on(t.userId, t.ts), index('usage_ts_idx').on(t.ts)],
);

export const systemSettings = pgTable('system_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').$type<unknown>().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
});
