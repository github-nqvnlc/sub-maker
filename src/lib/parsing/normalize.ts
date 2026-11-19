/**
 * Chuẩn hóa văn bản trước khi gửi đi đọc (docs/fpt-ai-voice-guide.md §6):
 * NFC, bỏ emoji/URL/ký tự điều khiển, gộp khoảng trắng.
 *
 * Các ký tự vô hình (zero-width, BOM, biến thể emoji…) được dựng từ MÃ SỐ thay vì viết trực tiếp
 * hoặc dạng escape, để mã nguồn đọc được và không bị công cụ/trình soạn thảo làm biến dạng.
 */

const fromCodes = (codes: number[]): string => codes.map((c) => String.fromCharCode(c)).join('');

/** Zero-width space/non-joiner, word joiner, BOM giữa chuỗi. */
const ZERO_WIDTH = fromCodes([0x200b, 0x200c, 0x2060, 0xfeff]);
/** Bộ chọn biến thể (FE0E/FE0F), zero-width joiner, khung bàn phím (20E3) đi kèm emoji. */
const EMOJI_JOINERS = fromCodes([0xfe0e, 0xfe0f, 0x200d, 0x20e3]);
/** Khoảng trắng "lạ": NBSP, các khoảng em/en, khoảng hẹp, khoảng ideographic. */
const ODD_SPACES = fromCodes([0x00a0, 0x202f, 0x205f, 0x3000, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a]);

const EMOJI = new RegExp(`[\\p{Extended_Pictographic}\\p{Emoji_Modifier}${EMOJI_JOINERS}]`, 'gu');
const URL_RE = /(?:https?:\/\/|www\.)[^\s<>"')\]]+/gi;
// Ký tự điều khiển (trừ tab/xuống dòng) và zero-width
const CONTROL = new RegExp(`[\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F\\x7F${ZERO_WIDTH}]`, 'g');
const ODD_SPACE_RE = new RegExp(`[${ODD_SPACES}\\t]+`, 'g');

export function normalizeInline(text: string): string {
  return text
    .normalize('NFC')
    .replace(URL_RE, ' ')
    .replace(EMOJI, '')
    .replace(CONTROL, '')
    .replace(ODD_SPACE_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Văn bản thuần: mỗi dòng không rỗng là một đoạn. */
export function plainToParagraphs(text: string): string[] {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

export const charLen = (s: string): number => [...s].length;

/** Có ít nhất một chữ hoặc chữ số (chuỗi chỉ gồm dấu câu không đọc được). */
export const hasSpeakable = (s: string): boolean => /[\p{L}\p{N}]/u.test(s);
