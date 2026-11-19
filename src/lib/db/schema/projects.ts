import { sql } from 'drizzle-orm';
import { check, index, integer, pgEnum, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { users } from './auth';
import { providerType } from './ai-config';

export const subtitleExt = pgEnum('subtitle_ext', ['txt', 'md', 'skt']);

export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** 1–120 ký tự, không toàn khoảng trắng, được phép trùng */
    name: text('name').notNull(),
    /** tối đa 2000 ký tự */
    description: text('description'),
    providerType: providerType('provider_type').notNull(),
    /** Số voice (đếm sẵn, cập nhật cùng giao dịch khi tạo/xóa voice) */
    voiceCount: integer('voice_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    // Cột `search_text` (cột sinh bằng immutable_unaccent) được thêm bằng migration tay 0001.
  },
  (t) => [
    check('projects_name_len', sql`char_length(btrim(${t.name})) between 1 and 120`),
    check('projects_desc_len', sql`${t.description} is null or char_length(${t.description}) <= 2000`),
    check('projects_voice_count_nonneg', sql`${t.voiceCount} >= 0`),
  ],
);

/** Bất biến sau khi tạo (sửa nội dung trong ứng dụng ngoài phạm vi). */
export const subtitleFiles = pgTable(
  'subtitle_files',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    originalName: text('original_name').notNull(),
    ext: subtitleExt('ext').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    storageKey: text('storage_key').notNull(),
    /** sha256 của văn bản đã chuẩn hóa */
    contentHash: text('content_hash').notNull(),
    charCount: integer('char_count').notNull(),
    segmentCount: integer('segment_count').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('subtitle_files_project_idx').on(t.projectId), index('subtitle_files_owner_idx').on(t.ownerId)],
);

export const segments = pgTable(
  'segments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    subtitleFileId: uuid('subtitle_file_id')
      .notNull()
      .references(() => subtitleFiles.id, { onDelete: 'cascade' }),
    /** thứ tự bắt đầu từ 0 */
    idx: integer('idx').notNull(),
    text: text('text').notNull(),
    charCount: integer('char_count').notNull(),
  },
  (t) => [unique('segments_file_idx_uq').on(t.subtitleFileId, t.idx), check('segments_idx_nonneg', sql`${t.idx} >= 0`)],
);
