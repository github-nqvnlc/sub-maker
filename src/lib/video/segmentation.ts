import type { SonioxToken } from '../providers/adapters/soniox-types';
import { graphemes } from '../overlay/layout';
import { splitWords, wordWeight } from '../overlay/words';
import type { Cue } from './types';

/**
 * Gom token song ngữ của Soniox thành cue (spec 006, contracts/subtitle-pipeline.md §1–§2; FR-014, FR-015, FR-018). Hàm thuần.
 *
 * Chữ dịch KHÔNG có mốc: mốc cue lấy từ lời gốc theo cụm (lời gốc + lời dịch đi liền sau). Cắt tại ranh giới cụm là mốc đo
 * (`measured`); phải cắt bên trong một cụm đã dịch thì mốc là ước lượng (`estimated`).
 */

export const SEGMENT_LIMITS = {
  /** từ tối đa mỗi dòng và mỗi cue (2 dòng) */
  lineWords: 12,
  cueWords: 24,
  /** ngôn ngữ không có khoảng trắng: tính theo ký tự */
  lineChars: 42,
  cueChars: 84,
  /** khoảng nghỉ lớn hơn mức này thì sang câu mới */
  pauseMs: 300,
  /** câu đã dài hơn mức này thì ngắt ở ranh giới cụm kế tiếp */
  sentenceMs: 7000,
  minCueMs: 700,
  hardMinMs: 100,
  /** đọc nhanh hơn mức này (ký tự mỗi giây) thì đánh dấu */
  fastCps: 21,
} as const;

export type SourceWord = { text: string; startMs: number; endMs: number };

export type Cluster = {
  startMs: number;
  endMs: number;
  speaker: string | null;
  language: string | null;
  /** chữ thô (giữ khoảng trắng đầu token) */
  source: string;
  target: string;
  sourceWords: SourceWord[];
  /** lời đã ở ngôn ngữ đích: câu dịch lấy nguyên câu gốc */
  sameLanguage: boolean;
  untranslated: boolean;
};

export type DraftCue = Omit<Cue, 'id'>;

const UNSPACED = /[぀-ヿ㐀-鿿豈-﫿฀-๿຀-໿ក-៿]/u;
const SENTENCE_END = /[.!?…。！？]["'”’»)\]]*$/u;
const CLAUSE_END = /[,;:、，；：]["'”’»)\]]*$/u;
const ANY_END = /[.!?…。！？,;:、，；：]["'”’»)\]]*$/u;

const clean = (s: string): string => s.normalize('NFC').replace(/\s+/gu, ' ').trim();

/** Chuỗi viết liền (Trung, Nhật, Thái…): đa số ký tự thuộc hệ chữ không dùng khoảng trắng. */
export function isUnspaced(text: string): boolean {
  const chars = [...text.replace(/\s+/gu, '')];
  if (chars.length === 0) return false;
  return chars.filter((c) => UNSPACED.test(c)).length * 2 > chars.length;
}

/** Câu dịch đọc nhanh hơn mức khuyến nghị trong `durationMs`. */
export const isFastText = (text: string, durationMs: number): boolean => graphemes(clean(text)).length / (durationMs / 1000) > SEGMENT_LIMITS.fastCps;

/** Nối hai đoạn chữ thô; hệ chữ có khoảng trắng thì không để hai từ dính nhau. */
function join(a: string, b: string): string {
  if (!a) return b;
  if (!b || /\s$/u.test(a) || /^\s/u.test(b)) return a + b;
  const [last, first] = [[...a].at(-1)!, [...b][0]!];
  return UNSPACED.test(last) || UNSPACED.test(first) ? a + b : `${a} ${b}`;
}

// ---- Token → cụm --------------------------------------------------------------------------------

export function toClusters(tokens: readonly SonioxToken[]): Cluster[] {
  const out: Cluster[] = [];
  let leading = ''; // chữ dịch đến trước mọi lời gốc
  let open: Cluster | null = null; // cụm đang nhận thêm lời gốc
  for (const t of tokens) {
    if (t.is_audio_event || typeof t.text !== 'string') continue;
    if (t.translation_status === 'translation') {
      const last = out.at(-1);
      if (last) last.target += t.text;
      else leading += t.text;
      open = null;
      continue;
    }
    const same = t.translation_status === 'none';
    const speaker = t.speaker ?? null;
    const startsWord = !open || /^\s/u.test(t.text) || UNSPACED.test(t.text);
    if (!open || open.speaker !== speaker || open.sameLanguage !== same) {
      open = { startMs: t.start_ms, endMs: t.end_ms, speaker, language: t.language ?? null, source: '', target: leading, sourceWords: [], sameLanguage: same, untranslated: false };
      leading = '';
      out.push(open);
    }
    open.source += t.text;
    open.endMs = Math.max(open.endMs, t.end_ms);
    const word = open.sourceWords.at(-1);
    if (startsWord || !word) open.sourceWords.push({ text: t.text, startMs: t.start_ms, endMs: t.end_ms });
    else {
      word.text += t.text;
      word.endMs = Math.max(word.endMs, t.end_ms);
    }
  }
  for (const c of out) {
    // đoạn đã ở ngôn ngữ đích: câu dịch = câu gốc (chữ dịch lạc vào, nếu có, nối sau)
    if (c.sameLanguage) c.target = join(c.source, c.target);
    c.untranslated = !c.sameLanguage && clean(c.target) === '';
  }
  // chỉ có chữ dịch, không có lời gốc nào: không có mốc nên không thành cue
  return out;
}

// ---- Giới hạn độ dài ----------------------------------------------------------------------------

type Measure = { units: number; max: number; line: number };

function measure(text: string): Measure {
  const t = clean(text);
  return isUnspaced(t)
    ? { units: graphemes(t).length, max: SEGMENT_LIMITS.cueChars, line: SEGMENT_LIMITS.lineChars }
    : { units: splitWords(t).length, max: SEGMENT_LIMITS.cueWords, line: SEGMENT_LIMITS.lineWords };
}

const fits = (text: string): boolean => {
  const m = measure(text);
  return m.units <= m.max;
};

/** Vị trí cắt gần giữa nhất, ưu tiên sau dấu câu nằm trong khoảng giữa. */
function cutIndex(items: readonly string[]): number {
  const n = items.length;
  const middle = n / 2;
  let best = -1;
  for (let k = Math.ceil(n * 0.25); k <= Math.floor(n * 0.75); k++) {
    if (k > 0 && k < n && ANY_END.test(items[k - 1]!.trim()) && (best < 0 || Math.abs(k - middle) < Math.abs(best - middle))) best = k;
  }
  return best > 0 ? best : Math.ceil(middle);
}

/** Chia dãy mảnh (từ, hoặc ký tự của chữ viết liền) thành các nhóm vừa một cue. */
function splitGroups<T>(items: readonly T[], textOf: (x: T) => string, whole: (xs: readonly T[]) => string): T[][] {
  if (items.length <= 1 || fits(whole(items))) return [[...items]];
  const k = cutIndex(items.map(textOf));
  return [...splitGroups(items.slice(0, k), textOf, whole), ...splitGroups(items.slice(k), textOf, whole)];
}

// ---- Cụm → câu → cue ----------------------------------------------------------------------------

type Piece = { startMs: number; endMs: number; source: string; target: string; speaker: string | null; language: string | null; untranslated: boolean; timing: 'measured' | 'estimated' };

const display = (c: Pick<Cluster, 'source' | 'target' | 'untranslated'>): string => clean(c.untranslated ? c.source : c.target);

const asPiece = (c: Cluster): Piece => ({ startMs: c.startMs, endMs: c.endMs, source: c.source, target: c.untranslated ? '' : c.target, speaker: c.speaker, language: c.language, untranslated: c.untranslated, timing: 'measured' });

function merge(a: Piece, b: Piece): Piece {
  const untranslated = a.untranslated && b.untranslated;
  return {
    ...a,
    startMs: Math.min(a.startMs, b.startMs),
    endMs: Math.max(a.endMs, b.endMs),
    source: join(a.source, b.source),
    target: join(a.target, b.target),
    untranslated,
    timing: a.timing === 'estimated' || b.timing === 'estimated' ? 'estimated' : 'measured',
  };
}

const mergedDisplay = (xs: readonly Piece[]): string => display(xs.reduce(merge));

function toSentences(clusters: readonly Cluster[]): Cluster[][] {
  const out: Cluster[][] = [];
  let cur: Cluster[] = [];
  for (const c of clusters) {
    const prev = cur.at(-1);
    if (
      prev &&
      (SENTENCE_END.test(display(prev)) ||
        prev.speaker !== c.speaker ||
        prev.untranslated !== c.untranslated ||
        c.startMs - prev.endMs > SEGMENT_LIMITS.pauseMs ||
        prev.endMs - cur[0]!.startMs > SEGMENT_LIMITS.sentenceMs)
    ) {
      out.push(cur);
      cur = [];
    }
    cur.push(c);
  }
  if (cur.length) out.push(cur);
  return out;
}

/** Một cụm tự vượt giới hạn: chia bên trong cụm. */
function splitCluster(c: Cluster): Piece[] {
  const base = asPiece(c);
  // Không có lời dịch riêng (chưa dịch hoặc đã ở ngôn ngữ đích): chia theo từ gốc, mốc là mốc đo của từng từ
  if (c.untranslated || (c.sameLanguage && clean(c.target) === clean(c.source))) {
    const groups = splitGroups(c.sourceWords, (w) => w.text, (ws) => ws.map((w) => w.text).join(''));
    return groups.map((ws) => {
      const text = ws.map((w) => w.text).join('');
      return { ...base, startMs: ws[0]!.startMs, endMs: ws.at(-1)!.endMs, source: text, target: c.untranslated ? '' : text };
    });
  }
  const target = clean(c.target);
  const unspaced = isUnspaced(target);
  const items = unspaced ? graphemes(target) : splitWords(target);
  const groups = splitGroups(items, (x) => x, (xs) => xs.join(unspaced ? '' : ' ')).map((xs) => xs.join(unspaced ? '' : ' '));
  const weights = groups.map((g) => (unspaced ? graphemes(g).length : splitWords(g).reduce((n, w) => n + wordWeight(w), 0)));
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  const start = c.startMs;
  const end = Math.max(c.endMs, start + groups.length * SEGMENT_LIMITS.hardMinMs);
  const boundaries = c.sourceWords.slice(1).map((w) => w.startMs);
  const cuts: number[] = [start];
  let acc = 0;
  for (let i = 0; i < groups.length - 1; i++) {
    acc += weights[i]!;
    const wanted = start + ((end - start) * acc) / total;
    const low = cuts[i]! + SEGMENT_LIMITS.hardMinMs;
    const high = end - (groups.length - 1 - i) * SEGMENT_LIMITS.hardMinMs;
    const near = boundaries.filter((b) => b >= low && b <= high).sort((a, b) => Math.abs(a - wanted) - Math.abs(b - wanted))[0];
    cuts.push(Math.round(near ?? Math.min(high, Math.max(low, wanted))));
  }
  cuts.push(end);
  // mỗi từ gốc thuộc đúng một phần: phần cuối nhận mọi từ còn lại
  let next = 0;
  return groups.map((g, i) => {
    const words: SourceWord[] = [];
    while (next < c.sourceWords.length && (i === groups.length - 1 || c.sourceWords[next]!.startMs < cuts[i + 1]!)) words.push(c.sourceWords[next++]!);
    return { ...base, startMs: cuts[i]!, endMs: cuts[i + 1]!, source: words.map((w) => w.text).join(''), target: g, timing: 'estimated' as const };
  });
}

/** Đóng gói các cụm của một câu thành cue vừa giới hạn, cắt ở ranh giới cụm (ưu tiên sau dấu ngắt nhịp). */
function packSentence(sentence: readonly Cluster[]): Piece[] {
  const out: Piece[] = [];
  let cur: Piece[] = [];
  const flush = (upTo = cur.length) => {
    if (upTo > 0) out.push(cur.slice(0, upTo).reduce(merge));
    cur = cur.slice(upTo);
  };
  for (const c of sentence) {
    if (!fits(display(c))) {
      flush();
      out.push(...splitCluster(c));
      continue;
    }
    const piece = asPiece(c);
    while (cur.length > 0 && !fits(mergedDisplay([...cur, piece]))) {
      let at = cur.length;
      for (let k = cur.length; k > 0; k--) {
        if (CLAUSE_END.test(display(cur[k - 1]!))) {
          at = k;
          break;
        }
      }
      flush(at);
    }
    cur.push(piece);
  }
  flush();
  return out;
}

/** Ngắt một cue dài thành hai dòng cân nhau, ưu tiên sau dấu câu. */
function twoLines(text: string): string {
  const m = measure(text);
  if (m.units <= m.line) return text;
  const unspaced = isUnspaced(text);
  const items = unspaced ? graphemes(text) : splitWords(text);
  const n = items.length;
  const low = Math.max(1, n - m.line);
  const high = Math.min(n - 1, m.line);
  let best = -1;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let k = low; k <= high; k++) {
    const score = Math.abs(k - n / 2) - (ANY_END.test(items[k - 1]!) ? n : 0);
    if (score < bestScore) {
      best = k;
      bestScore = score;
    }
  }
  const at = best > 0 ? best : Math.ceil(n / 2);
  const sep = unspaced ? '' : ' ';
  return `${items.slice(0, at).join(sep)}\n${items.slice(at).join(sep)}`;
}

/** Mốc tăng dần, không chồng, nằm trong video; cue quá ngắn được gộp hoặc đẩy cue sau; rồi bảo đảm thời lượng hiển thị tối thiểu. */
function fitTimes(pieces: readonly Piece[], durationMs: number): Piece[] {
  const MIN = SEGMENT_LIMITS.hardMinMs;
  const lastStart = Math.max(0, durationMs - MIN);
  const out: Piece[] = [];
  let prevStart = 0;
  for (const raw of pieces) {
    const startMs = Math.min(lastStart, Math.max(prevStart, Math.round(raw.startMs)));
    let next: Piece = { ...raw, startMs, endMs: Math.min(durationMs, Math.max(startMs + MIN, Math.round(raw.endMs))) };
    prevStart = startMs;
    while (out.length > 0 && out.at(-1)!.endMs > next.startMs) {
      const last = out.at(-1)!;
      if (next.startMs - last.startMs >= MIN) {
        last.endMs = next.startMs;
        break;
      }
      const together = merge(last, next);
      const shifted = last.startMs + MIN;
      if (fits(display(together)) || shifted > lastStart) {
        out.pop();
        next = together;
      } else {
        // gộp sẽ vượt giới hạn chữ: giữ cue trước ở mức ngắn nhất và lùi cue sau
        last.endMs = shifted;
        next = { ...next, startMs: shifted, endMs: Math.min(durationMs, Math.max(shifted + MIN, next.endMs)) };
        prevStart = shifted;
      }
    }
    out.push(next);
  }
  for (let i = 0; i < out.length; i++) {
    const c = out[i]!;
    if (c.endMs - c.startMs < SEGMENT_LIMITS.minCueMs) {
      const limit = Math.min(out[i + 1]?.startMs ?? durationMs, durationMs);
      c.endMs = Math.max(c.endMs, Math.min(c.startMs + SEGMENT_LIMITS.minCueMs, limit));
    }
  }
  return out;
}

export function segmentCues(tokens: readonly SonioxToken[], opts: { durationMs: number }): DraftCue[] {
  const pieces = toSentences(toClusters(tokens)).flatMap(packSentence);
  return fitTimes(pieces, opts.durationMs).map((p) => {
    const sourceText = p.untranslated ? twoLines(clean(p.source)) : clean(p.source);
    const targetText = p.untranslated ? '' : twoLines(clean(p.target));
    return {
      startMs: p.startMs,
      endMs: p.endMs,
      timing: p.timing,
      sourceText,
      targetText,
      sourceLang: p.language,
      speaker: p.speaker,
      flags: { ...(p.untranslated ? { untranslated: true } : {}), ...(isFastText(targetText, p.endMs - p.startMs) ? { fast: true } : {}) },
    };
  });
}
