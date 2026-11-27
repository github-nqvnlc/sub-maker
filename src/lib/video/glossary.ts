import type { GlossaryPair } from './types';

/**
 * Từ điển thuật ngữ của một Project (spec 006, FR-019, FR-020; contracts/subtitle-pipeline.md §5). Hàm thuần, dùng chung trình duyệt
 * (dán hàng loạt) và máy chủ (kiểm khi lưu). Giới hạn số cặp và tổng ký tự lấy từ cài đặt, truyền vào hàm.
 */

/** Độ dài tối đa của mỗi vế, tính theo điểm mã. */
export const GLOSSARY_TERM_MAX = 100;

export type GlossaryLimits = { maxPairs: number; maxChars: number };
export type GlossaryReason = 'missing' | 'too_long' | 'duplicate' | 'limit';
/** `line` đếm từ 1: số dòng đã dán, hoặc thứ tự cặp trong danh sách gửi lên. */
export type GlossaryLineError = { line: number; reason: GlossaryReason };

const clean = (s: string): string => s.normalize('NFC').trim();
const length = (s: string): number => [...s].length;

/** Hai từ gốc trùng nhau khi chỉ khác chữ hoa, chữ thường hoặc cách ghép dấu. */
export const glossaryKey = (source: string): string => clean(source).toLocaleLowerCase('vi');

export const glossaryChars = (pairs: readonly GlossaryPair[]): number => pairs.reduce((n, p) => n + length(p.source) + length(p.target), 0);

/** Cặp đã chuẩn hóa; "giữ nguyên" (đã chọn, hoặc hai vế giống nhau) đặt bản dịch bằng từ gốc. */
function toPair(source: string, target: string, keep: boolean): GlossaryPair | 'missing' | 'too_long' {
  const s = clean(source);
  const t = keep ? s : clean(target);
  if (!s || !t || /[\r\n]/.test(`${s}${t}`)) return 'missing';
  if (length(s) > GLOSSARY_TERM_MAX || length(t) > GLOSSARY_TERM_MAX) return 'too_long';
  return { source: s, target: t, keep: keep || s === t };
}

/**
 * Dán hàng loạt: mỗi dòng một cặp, tách tại `->` đầu tiên, không có thì tại dấu phẩy đầu tiên. Dòng lỗi được nêu riêng, dòng hợp lệ
 * vẫn được thêm cho tới khi chạm giới hạn.
 */
export function parseGlossaryLines(text: string, existing: readonly GlossaryPair[], limits: GlossaryLimits): { added: GlossaryPair[]; errors: GlossaryLineError[] } {
  const added: GlossaryPair[] = [];
  const errors: GlossaryLineError[] = [];
  const keys = new Set(existing.map((p) => glossaryKey(p.source)));
  let chars = glossaryChars(existing);
  text.split(/\r\n|\r|\n/).forEach((raw, index) => {
    if (!raw.trim()) return;
    const fail = (reason: GlossaryReason) => void errors.push({ line: index + 1, reason });
    const arrow = raw.indexOf('->');
    const at = arrow >= 0 ? arrow : raw.indexOf(',');
    if (at < 0) return fail('missing');
    const pair = toPair(raw.slice(0, at), raw.slice(at + (arrow >= 0 ? 2 : 1)), false);
    if (typeof pair === 'string') return fail(pair);
    if (keys.has(glossaryKey(pair.source))) return fail('duplicate');
    const size = glossaryChars([pair]);
    if (existing.length + added.length + 1 > limits.maxPairs || chars + size > limits.maxChars) return fail('limit');
    keys.add(glossaryKey(pair.source));
    chars += size;
    added.push(pair);
  });
  return { added, errors };
}

export type GlossaryCheck = { ok: true; pairs: GlossaryPair[] } | { ok: false; code: 'GLOSSARY_INVALID' | 'GLOSSARY_TOO_LARGE'; errors: GlossaryLineError[] };

/** Kiểm cả danh sách trước khi lưu: hoặc nhận toàn bộ, hoặc không nhận gì. */
export function validateGlossary(pairs: readonly GlossaryPair[], limits: GlossaryLimits): GlossaryCheck {
  const out: GlossaryPair[] = [];
  const errors: GlossaryLineError[] = [];
  const keys = new Set<string>();
  pairs.forEach((p, index) => {
    const pair = toPair(p.source, p.target, p.keep);
    if (typeof pair === 'string') return void errors.push({ line: index + 1, reason: pair });
    const key = glossaryKey(pair.source);
    if (keys.has(key)) return void errors.push({ line: index + 1, reason: 'duplicate' });
    keys.add(key);
    out.push(pair);
  });
  if (errors.length > 0) return { ok: false, code: 'GLOSSARY_INVALID', errors };
  if (out.length > limits.maxPairs || glossaryChars(out) > limits.maxChars) return { ok: false, code: 'GLOSSARY_TOO_LARGE', errors: [] };
  return { ok: true, pairs: out };
}
