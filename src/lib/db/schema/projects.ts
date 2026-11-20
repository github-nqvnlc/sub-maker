import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, jsonb, pgEnum, pgTable, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { users } from './auth';
import { providerType } from './ai-config';

export const subtitleExt = pgEnum('subtitle_ext', ['txt', 'md', 'srt']);

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

/** Mã cảnh báo khi chuẩn hóa cue phụ đề (spec 003, FR-005). */
export type CueWarningCode = 'BAD_RANGE' | 'OUT_OF_ORDER' | 'OVERLAP' | 'NO_SPEECH';
export type CueWarning = { cue: number; code: CueWarningCode };
/** Số cảnh báo tối đa lưu trong `subtitle_files.cue_warnings`; số thật nằm ở `cue_warning_count`. */
export const MAX_STORED_CUE_WARNINGS = 200;

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
    /** `true` khi `.srt` có ≥ 1 cue hợp lệ (cho phép chế độ khớp mốc). `.txt/.md` luôn `false`. */
    hasTimecodes: boolean('has_timecodes').notNull().default(false),
    /** Số cue hợp lệ sau chuẩn hóa (NULL khi không có mốc). */
    cueCount: integer('cue_count'),
    /** `end_ms` của cue cuối (NULL khi không có mốc). */
    durationMs: integer('duration_ms'),
    /** Tối đa ${MAX_STORED_CUE_WARNINGS} cảnh báo; số thật ở `cue_warning_count`. */
    cueWarnings: jsonb('cue_warnings').$type<CueWarning[]>().notNull().default(sql`'[]'::jsonb`),
    cueWarningCount: integer('cue_warning_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('subtitle_files_project_idx').on(t.projectId),
    index('subtitle_files_owner_idx').on(t.ownerId),
    check('subtitle_files_cue_count_nonneg', sql`${t.cueCount} is null or ${t.cueCount} >= 0`),
    check('subtitle_files_duration_nonneg', sql`${t.durationMs} is null or ${t.durationMs} >= 0`),
  ],
);

/**
 * Cue phụ đề đã chuẩn hóa (spec 003). Bất biến sau khi tạo; quyền truy cập luôn qua `subtitle_files.owner_id`.
 * Số thứ tự gốc `n` chỉ để đối chiếu, không dùng để đọc.
 */
export const subtitleCues = pgTable(
  'subtitle_cues',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    subtitleFileId: uuid('subtitle_file_id')
      .notNull()
      .references(() => subtitleFiles.id, { onDelete: 'cascade' }),
    /** thứ tự sau chuẩn hóa, bắt đầu từ 0 */
    idx: integer('idx').notNull(),
    /** số thứ tự gốc trong tệp */
    n: integer('n').notNull(),
    startMs: integer('start_ms').notNull(),
    endMs: integer('end_ms').notNull(),
    /** chữ đọc đã làm sạch, NFC; rỗng khi `speakable = false` */
    text: text('text').notNull(),
    speakable: boolean('speakable').notNull().default(true),
    /** số ký tự tính phí (code point, NFC) */
    charCount: integer('char_count').notNull(),
  },
  (t) => [
    uniqueIndex('subtitle_cues_file_idx_uq').on(t.subtitleFileId, t.idx),
    index('subtitle_cues_file_start_idx').on(t.subtitleFileId, t.startMs),
    check('subtitle_cues_idx_nonneg', sql`${t.idx} >= 0`),
    check('subtitle_cues_start_nonneg', sql`${t.startMs} >= 0`),
    check('subtitle_cues_end_after_start', sql`${t.endMs} > ${t.startMs}`),
    check('subtitle_cues_chars_nonneg', sql`${t.charCount} >= 0`),
  ],
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
