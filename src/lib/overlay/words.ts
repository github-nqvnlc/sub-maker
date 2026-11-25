import type { AppliedCue, WordSpan } from './types';

/**
 * Mốc từng từ ƯỚC LƯỢNG, chỉ để hiển thị (FR-024, FR-025; overlay-engine §3, research R8). Không gọi nhà cung cấp AI.
 * Khoảng đọc [startMs, readEndMs) được chia theo trọng số của từ, có quãng nghỉ sau dấu câu. "Từ" là cụm ký tự giữa hai khoảng trắng.
 */
export const WORD_TIMING = {
  /** phần cố định của một từ: tiếng Việt đơn âm tiết nên mỗi tiếng gần bằng nhau */
  base: 3,
  perLetter: 1,
  perDigit: 4,
  symbolOnly: 1,
  /** quãng nghỉ tính theo trọng số trung bình của câu */
  pauseComma: 0.5,
  pauseStop: 0.8,
  /** tổng quãng nghỉ không vượt phần này của khoảng đọc */
  maxPauseShare: 0.25,
} as const;

export const splitWords = (text: string): string[] => text.normalize('NFC').split(/\s+/u).filter(Boolean);

export function wordWeight(word: string): number {
  const letters = (word.match(/\p{L}/gu) ?? []).length;
  const digits = (word.match(/\p{Nd}/gu) ?? []).length;
  if (letters + digits === 0) return WORD_TIMING.symbolOnly;
  return (letters > 0 ? WORD_TIMING.base + letters * WORD_TIMING.perLetter : 0) + digits * WORD_TIMING.perDigit;
}

const STOP = /[.!?…。！？]["'”’)\]]*$/u;
const COMMA = /[,;:，；：]["'”’)\]]*$/u;

export function wordSpans(cue: Pick<AppliedCue, 'startMs' | 'readEndMs' | 'text'>): WordSpan[] {
  const words = splitWords(cue.text);
  if (words.length === 0) return [];
  const span = Math.max(0, cue.readEndMs - cue.startMs);
  const weights = words.map(wordWeight);
  const sum = weights.reduce((a, b) => a + b, 0);
  const avg = sum / words.length;
  const pauses = words.map((w, i) => {
    if (i === words.length - 1) return 0;
    if (STOP.test(w)) return avg * WORD_TIMING.pauseStop;
    return COMMA.test(w) ? avg * WORD_TIMING.pauseComma : 0;
  });
  const pauseSum = pauses.reduce((a, b) => a + b, 0);
  // Σnghỉ / (Σtừ + Σnghỉ) ≤ maxPauseShare
  const maxPause = (sum * WORD_TIMING.maxPauseShare) / (1 - WORD_TIMING.maxPauseShare);
  const k = pauseSum > maxPause ? maxPause / pauseSum : 1;
  const total = sum + pauseSum * k;

  const out: WordSpan[] = [];
  let acc = 0;
  for (let i = 0; i < words.length; i++) {
    const startMs = cue.startMs + Math.round((span * acc) / total);
    acc += weights[i]!;
    const endMs = i === words.length - 1 ? cue.startMs + span : cue.startMs + Math.round((span * acc) / total);
    acc += pauses[i]! * k;
    out.push({ text: words[i]!, startMs, endMs });
  }
  return out;
}

/** Từ đang đọc: từ cuối cùng đã bắt đầu, giữ qua quãng nghỉ; hết khoảng đọc thì không từ nào (-1). */
export function activeWordIndex(spans: readonly WordSpan[], tMs: number, readEndMs: number): number {
  if (tMs >= readEndMs) return -1;
  let ans = -1;
  for (let i = 0; i < spans.length; i++) if (spans[i]!.startMs <= tMs) ans = i;
  return ans;
}
