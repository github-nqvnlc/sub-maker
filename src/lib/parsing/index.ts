import { createHash } from 'node:crypto';
import { ScriptError, validateScript, type ScriptExt } from './detect';
import { markdownToParagraphs } from './markdown';
import { charLen, normalizeInline, plainToParagraphs } from './normalize';
import { buildSegments, DEFAULT_MAX_SEGMENT_CHARS } from './segmenter';
import { sktToParagraphs } from './skt';

export { ScriptError, extOf } from './detect';
export type { ScriptExt } from './detect';
export { DEFAULT_MAX_SEGMENT_CHARS } from './segmenter';

export type ParsedScript = {
  ext: ScriptExt;
  /** Văn bản gốc đã giải mã UTF-8 (để xem lại tệp đã upload, FR-010). */
  rawText: string;
  /** Các đoạn sẽ được đọc theo thứ tự (FR-011). */
  segments: string[];
  /** Tổng ký tự Unicode của các đoạn. */
  charCount: number;
  /** sha256 của văn bản đã chuẩn hóa (các đoạn nối bằng "\n"). */
  contentHash: string;
};

/**
 * Kiểm tra → bóc định dạng → chuẩn hóa → tách đoạn. Ném ScriptError (tiếng Việt) khi tệp không hợp lệ.
 * Ranh giới đoạn cố định lúc upload nên mọi lần chạy cùng một file cho cùng các đoạn.
 */
export function parseScript(
  fileName: string,
  bytes: Uint8Array,
  opts: { maxBytes: number; maxSegmentChars?: number },
): ParsedScript {
  const { ext, text } = validateScript(fileName, bytes, opts.maxBytes);

  const paragraphs = (ext === 'md' ? markdownToParagraphs(text) : ext === 'skt' ? sktToParagraphs(text) : plainToParagraphs(text))
    .map(normalizeInline)
    .filter(Boolean);

  const segments = buildSegments(paragraphs, opts.maxSegmentChars ?? DEFAULT_MAX_SEGMENT_CHARS);
  if (segments.length === 0) {
    throw new ScriptError('EMPTY', 'Tệp không có nội dung đọc được (sau khi bỏ ký hiệu định dạng, mốc thời gian, emoji và liên kết).');
  }
  const charCount = segments.reduce((n, s) => n + charLen(s), 0);
  const contentHash = createHash('sha256').update(segments.join('\n'), 'utf8').digest('hex');
  return { ext, rawText: text, segments, charCount, contentHash };
}
