import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const userRole = pgEnum('user_role', ['admin', 'user']);
export const userStatus = pgEnum('user_status', ['active', 'banned', 'deleting']);

/**
 * Bảng người dùng (mô hình "user" của thư viện xác thực) mở rộng theo data-model.md.
 * - `name` = tên hiển thị (FR-035), 1–60 ký tự.
 * - `role`, `status`, `can_use_custom_ai`, `storage_used_bytes` do máy chủ quản lý, không nhận từ client.
 */
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    emailVerified: boolean('email_verified').notNull().default(false),
    name: text('display_name').notNull(),
    image: text('image'),
    bio: text('bio'),
    avatarKey: text('avatar_key'),
    role: userRole('role').notNull().default('user'),
    status: userStatus('status').notNull().default('active'),
    canUseCustomAi: boolean('can_use_custom_ai').notNull().default(false),
    storageUsedBytes: bigint('storage_used_bytes', { mode: 'number' }).notNull().default(0),
    /** Ngôn ngữ giao diện (spec 003, FR-021): vi | en */
    locale: text('locale').notNull().default('vi'),
    /** Chế độ giao diện (spec 003, FR-016): light | dark | system */
    theme: text('theme').notNull().default('system'),
    lastActiveAt: timestamp('last_active_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('users_email_lower_uq').on(sql`lower(${t.email})`),
    check('users_name_len', sql`char_length(${t.name}) between 1 and 60`),
    check('users_bio_len', sql`${t.bio} is null or char_length(${t.bio}) <= 500`),
    check('users_storage_nonneg', sql`${t.storageUsedBytes} >= 0`),
    check('users_locale_valid', sql`${t.locale} in ('vi','en')`),
    check('users_theme_valid', sql`${t.theme} in ('light','dark','system')`),
    index('users_status_idx').on(t.status),
    index('users_created_idx').on(t.createdAt),
  ],
);

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    token: text('token').notNull().unique(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
);

export const accounts = pgTable(
  'accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
    scope: text('scope'),
    password: text('password'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('accounts_user_idx').on(t.userId)],
);

export const verifications = pgTable('verifications', {
  id: uuid('id').primaryKey().defaultRandom(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Giới hạn tốc độ đăng nhập/đăng ký, lưu bền trong DB để không mất khi khởi động lại (Nguyên tắc I). */
export const rateLimits = pgTable('rate_limits', {
  id: uuid('id').primaryKey().defaultRandom(),
  key: text('key').notNull().unique(),
  count: integer('count').notNull(),
  lastRequest: bigint('last_request', { mode: 'number' }).notNull(),
});
