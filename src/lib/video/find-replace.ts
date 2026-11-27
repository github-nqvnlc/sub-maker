import type { CueOp } from './cue-ops';
import type { Cue } from './types';

/**
 * Tìm và thay trong phụ đề (spec 006, FR-025; contracts/subtitle-pipeline.md §4). Hàm thuần. Vị trí tính theo đơn vị mã UTF-16 trên
 * chuỗi NFC; không bao giờ cắt giữa một ký tự và dấu của nó.
 */

export type FindColumn = 'target' | 'source';
export type FindOptions = { query: string; column: FindColumn; caseSensitive: boolean; wholeWord: boolean; matchDiacritics: boolean };
export type FindMatch = { cueId: string; start: number; end: number; matched: string };

const MARKS = /\p{M}/gu;
const MARK_AT_START = /^\p{M}/u;
const WORD_AT_END = /[\p{L}\p{N}\p{M}]$/u;
const WORD_AT_START = /^[\p{L}\p{N}\p{M}]/u;

const stripMarks = (s: string): string => s.normalize('NFD').replace(MARKS, '').replaceAll('đ', 'd').replaceAll('Đ', 'D');

/** Từ tìm không dấu thì khớp cả chữ có dấu; có dấu thì khớp đúng dấu. */
export const defaultMatchDiacritics = (query: string): boolean => stripMarks(query.normalize('NFC')) !== query.normalize('NFC');

type Folded = { text: string; /** vị trí gốc của đầu và cuối ký tự sinh ra đơn vị mã thứ i */ from: number[]; to: number[] };

/** Chuỗi dùng để so khớp, kèm ánh xạ ngược về chuỗi NFC gốc. */
function fold(nfc: string, o: Pick<FindOptions, 'caseSensitive' | 'matchDiacritics'>): Folded {
  let text = '';
  const from: number[] = [];
  const to: number[] = [];
  let at = 0;
  for (const char of nfc) {
    let f = o.matchDiacritics ? char : stripMarks(char);
    if (!o.caseSensitive) f = f.toLocaleLowerCase('vi');
    for (let i = 0; i < f.length; i++) {
      from.push(at);
      to.push(at + char.length);
    }
    text += f;
    at += char.length;
  }
  return { text, from, to };
}

/** Chuỗi đã gập của từng cue theo tùy chọn: gập lại từng ký tự của cả kịch bản ở mỗi phím gõ thì khựng. Cue sửa là đối tượng mới. */
const foldedCues = new WeakMap<Cue, Map<string, { text: string; hay: Folded }>>();

function foldedOf(cue: Cue, o: FindOptions): { text: string; hay: Folded } {
  const key = `${o.column}|${o.caseSensitive}|${o.matchDiacritics}`;
  let byOption = foldedCues.get(cue);
  if (!byOption) foldedCues.set(cue, (byOption = new Map()));
  let hit = byOption.get(key);
  if (!hit) {
    const text = (o.column === 'source' ? cue.sourceText : cue.targetText).normalize('NFC');
    byOption.set(key, (hit = { text, hay: fold(text, o) }));
  }
  return hit;
}

export function findInCues(cues: readonly Cue[], o: FindOptions): FindMatch[] {
  const needle = fold(o.query.normalize('NFC'), o).text;
  if (!needle) return [];
  const out: FindMatch[] = [];
  for (const cue of cues) {
    const { text, hay } = foldedOf(cue, o);
    let search = 0;
    for (let i = hay.text.indexOf(needle, search); i >= 0; i = hay.text.indexOf(needle, search)) {
      search = i + 1;
      const start = hay.from[i]!;
      let end = hay.to[i + needle.length - 1]!;
      // dấu rời đi liền sau chữ cuối: khớp đúng dấu thì đó là chữ khác, không khớp dấu thì lấy cả cụm
      if (MARK_AT_START.test(text.slice(end))) {
        if (o.matchDiacritics) continue;
        while (MARK_AT_START.test(text.slice(end))) end += String.fromCodePoint(text.codePointAt(end)!).length;
      }
      // không bắt đầu giữa một ký tự đã bị tách khi gập
      if (i > 0 && hay.from[i - 1] === start) continue;
      if (o.wholeWord && (WORD_AT_END.test(text.slice(0, start)) || WORD_AT_START.test(text.slice(end)))) continue;
      out.push({ cueId: cue.id, start, end, matched: text.slice(start, end) });
      search = i + needle.length;
    }
  }
  return out;
}

export type MatchVariant = { form: string; count: number };

/** Các dạng khớp khác nhau (khác dấu; không tính khác hoa, thường), theo thứ tự xuất hiện. */
export function matchVariants(matches: readonly FindMatch[]): MatchVariant[] {
  const counts = new Map<string, number>();
  for (const m of matches) {
    const form = m.matched.toLocaleLowerCase('vi');
    counts.set(form, (counts.get(form) ?? 0) + 1);
  }
  return [...counts].map(([form, count]) => ({ form, count }));
}

/**
 * Một lô thao tác thay các vị trí đã tìm (hoàn tác bằng một thao tác). Vị trí không còn đúng chữ đã khớp (cue đã đổi hoặc đã xóa) bị
 * bỏ qua và không được đếm.
 */
export function replaceOps(cues: readonly Cue[], matches: readonly FindMatch[], replacement: string, column: FindColumn): { ops: CueOp[]; replaced: number } {
  const byCue = new Map<string, FindMatch[]>();
  for (const m of matches) {
    const list = byCue.get(m.cueId);
    if (list) list.push(m);
    else byCue.set(m.cueId, [m]);
  }
  const ops: CueOp[] = [];
  let replaced = 0;
  const insert = replacement.normalize('NFC');
  for (const cue of cues) {
    const list = byCue.get(cue.id);
    if (!list) continue;
    const original = (column === 'source' ? cue.sourceText : cue.targetText).normalize('NFC');
    let text = original;
    let count = 0;
    // thay từ cuối lên đầu để các vị trí phía trước không xê dịch
    for (const m of [...list].sort((a, b) => b.start - a.start)) {
      if (text.slice(m.start, m.end) !== m.matched) continue;
      text = text.slice(0, m.start) + insert + text.slice(m.end);
      count++;
    }
    text = text.normalize('NFC');
    if (text === original) continue;
    replaced += count;
    ops.push({ type: 'update', id: cue.id, patch: column === 'source' ? { sourceText: text } : { targetText: text } });
  }
  return { ops, replaced };
}
