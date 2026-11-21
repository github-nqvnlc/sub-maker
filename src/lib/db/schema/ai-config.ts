import { sql } from 'drizzle-orm';
import { boolean, check, customType, index, integer, numeric, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { users } from './auth';

export const providerType = pgEnum('provider_type', ['fpt_marketplace', 'shopaikey_openai', 'shopaikey_minimax', 'openai_compatible']);
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
    type: providerType('type').notNull(),
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
