import { sql } from 'drizzle-orm';
import { boolean, check, customType, index, integer, jsonb, numeric, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { users } from './auth';

/**
 * Kiểu nhà cung cấp trong CSDL. 4 giá trị đầu là nhà cung cấp TTS (chọn adapter); `soniox` chỉ dùng cho bản ghi
 * sử dụng của STT (spec 004) — cấu hình Soniox nằm ở bảng riêng `stt_provider_configs`.
 */
export const providerType = pgEnum('provider_type', ['fpt_marketplace', 'shopaikey_openai', 'shopaikey_minimax', 'openai_compatible', 'soniox']);
/** Nhà cung cấp TTS (các cột cấu hình/Project/job chỉ chứa các giá trị này). */
export type TtsProviderType = 'fpt_marketplace' | 'shopaikey_openai' | 'shopaikey_minimax' | 'openai_compatible' | 'soniox';
export const configScope = pgEnum('config_scope', ['global', 'user']);
export const disabledReason = pgEnum('config_disabled_reason', ['owner_removed_from_list', 'admin_disabled']);

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

/** Cấu hình nhà cung cấp AI. Khóa API luôn lưu mã hóa (AES-256-GCM), không bao giờ trả ra API. */
export const aiProviderConfigs = pgTable(
  'ai_provider_configs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    scope: configScope('scope').notNull(),
    ownerUserId: uuid('owner_user_id').references(() => users.id, { onDelete: 'cascade' }),
    type: providerType('type').$type<TtsProviderType>().notNull(),
    name: text('name').notNull(),
    baseUrl: text('base_url').notNull(),
    apiKeyEnc: bytea('api_key_enc').notNull(),
    apiKeyHint: text('api_key_hint').notNull(),
    defaultModel: text('default_model'),
    defaultVoice: text('default_voice'),
    defaultSpeed: numeric('default_speed', { mode: 'number' }),
    maxCharsPerRequest: integer('max_chars_per_request').notNull(),
    pricePerMillionChars: numeric('price_per_million_chars', { mode: 'number' }),
    enabled: boolean('enabled').notNull().default(true),
    disabledReason: disabledReason('disabled_reason'),
    lastTestAt: timestamp('last_test_at', { withTimezone: true }),
    lastTestOk: boolean('last_test_ok'),
    lastTestMessage: text('last_test_message'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // global: owner NULL; user: owner bắt buộc
    check('ai_config_owner_scope', sql`(${t.scope} = 'global' and ${t.ownerUserId} is null) or (${t.scope} = 'user' and ${t.ownerUserId} is not null)`),
    // mỗi loại có một cấu hình chung và mỗi User một cấu hình riêng cho mỗi loại
    uniqueIndex('ai_config_scope_owner_type_uq').on(t.scope, sql`coalesce(${t.ownerUserId}, '00000000-0000-0000-0000-000000000000'::uuid)`, t.type),
    index('ai_config_owner_idx').on(t.ownerUserId),
  ],
);

/**
 * Cấu hình nhà cung cấp STT dùng chung (spec 004, FR-009): một token Soniox duy nhất cho mọi model.
 * Mỗi nhà cung cấp tối đa một dòng (`provider` duy nhất). Khóa API mã hóa AES-256-GCM, chỉ trả `apiKeyHint`.
 */
export const sttProviderConfigs = pgTable('stt_provider_configs', {
  id: uuid('id').primaryKey().defaultRandom(),
  provider: text('provider').$type<'soniox'>().notNull().unique(),
  baseUrl: text('base_url').notNull(),
  apiKeyEnc: bytea('api_key_enc').notNull(),
  apiKeyHint: text('api_key_hint').notNull(),
  /** Model async mặc định cho tạo phụ đề (FR-010); không nhận model real-time `stt-rt-*`. */
  defaultModel: text('default_model').notNull().default('stt-async-v6'),
  enableDiarization: boolean('enable_diarization').notNull().default(false),
  /** Đơn giá ước tính USD/giờ âm thanh; NULL = không ước tính chi phí (Nguyên tắc IV). */
  pricePerAudioHourUsd: numeric('price_per_audio_hour_usd', { mode: 'number' }),
  enabled: boolean('enabled').notNull().default(true),
  lastTestAt: timestamp('last_test_at', { withTimezone: true }),
  lastTestOk: boolean('last_test_ok'),
  lastTestMessage: text('last_test_message'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const providerAccessMode = pgEnum('provider_access_mode', ['public', 'restricted', 'private']);

/**
 * Nhà cung cấp chuẩn OpenAI do Administrator tạo (spec 004, FR-012..014, data-model §2).
 * Cấu hình AI riêng của User KHÔNG nằm ở đây mà ở `ai_provider_configs` (scope = 'user').
 */
export const customAiProviders = pgTable(
  'custom_ai_providers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    baseUrl: text('base_url').notNull(),
    apiKeyEnc: bytea('api_key_enc').notNull(),
    apiKeyHint: text('api_key_hint').notNull(),
    models: jsonb('models').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    defaultModel: text('default_model'),
    defaultVoice: text('default_voice'),
    accessMode: providerAccessMode('access_mode').notNull().default('private'),
    /** Danh sách id User khi `access_mode = 'restricted'` */
    assignedUserIds: jsonb('assigned_user_ids').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    enabled: boolean('enabled').notNull().default(true),
    pricePerMillionChars: numeric('price_per_million_chars', { mode: 'number' }),
    lastTestAt: timestamp('last_test_at', { withTimezone: true }),
    lastTestOk: boolean('last_test_ok'),
    lastTestMessage: text('last_test_message'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('custom_ai_access_mode_idx').on(t.accessMode),
    check('custom_ai_name_len', sql`char_length(btrim(${t.name})) between 1 and 100`),
  ],
);
