import { graphemes } from '../overlay/layout';
import { splitWords, wordWeight } from '../overlay/words';
import { isFastText, isUnspaced } from './segmentation';
import { CUE_LIMITS, type Cue, type CueFlags } from './types';

/**
 * Lô thao tác sửa cue (spec 006, contracts/subtitle-pipeline.md §3; FR-023, FR-024). Hàm thuần, dùng chung trình duyệt và máy chủ.
 * Danh sách cue luôn sắp theo mốc bắt đầu.
 */

/** `timing` và `flags` chỉ cần khi hoàn tác; vắng thì suy ra từ thay đổi. */
export type CuePatch = Partial<Pick<Cue, 'startMs' | 'endMs' | 'sourceText' | 'targetText' | 'timing' | 'flags'>>;
export type CueOp = { type: 'update'; id: string; patch: CuePatch } | { type: 'insert'; cue: Cue } | { type: 'delete'; id: string };
export type CueBatch = { baseRevision: number; ops: CueOp[] };

export const MAX_CUE_OPS = 20_000;
/** Thời lượng của cue thêm mới khi khoảng trống đủ chỗ. */
const NEW_CUE_MS = 2000;

export type CueViolationReason = 'missing' | 'duplicate' | 'range' | 'too_short' | 'past_end' | 'overlap' | 'text' | 'too_many';
export type CueViolation = { id: string; reason: CueViolationReason };

export type ApplyResult =
  | {
      ok: true;
      cues: Cue[];
      /** Áp dụng lô này lên kết quả sẽ trở lại danh sách ban đầu. */
      inverse: CueOp[];
      /** cue mới hoặc đã đổi, ở trạng thái cuối */
      changed: Cue[];
      /** id có trong danh sách ban đầu và không còn nữa */
      removed: string[];
    }
  | { ok: false; violation: CueViolation };

const MIN = CUE_LIMITS.minDurationMs;

const sameFlags = (a: CueFlags, b: CueFlags) => !!a.untranslated === !!b.untranslated && !!a.fast === !!b.fast && !!a.review === !!b.review;

/** Cờ sau khi người dùng đổi chữ hoặc mốc: đã có câu dịch thì hết "chưa dịch"; tốc độ đọc tính lại. */
function flagsAfterEdit(prev: Cue, next: Cue): CueFlags {
  const retranslated = next.targetText !== prev.targetText;
  const flags: CueFlags = {};
  if (prev.flags.untranslated && !(retranslated && next.targetText.trim())) flags.untranslated = true;
  if (prev.flags.review && !retranslated) flags.review = true;
  if (isFastText(next.targetText, next.endMs - next.startMs)) flags.fast = true;
  return flags;
}

function patched(prev: Cue, patch: CuePatch): Cue {
  const next: Cue = {
    ...prev,
    startMs: patch.startMs ?? prev.startMs,
    endMs: patch.endMs ?? prev.endMs,
    sourceText: patch.sourceText?.normalize('NFC') ?? prev.sourceText,
    targetText: patch.targetText?.normalize('NFC') ?? prev.targetText,
  };
  const moved = next.startMs !== prev.startMs || next.endMs !== prev.endMs;
  const retext = next.sourceText !== prev.sourceText || next.targetText !== prev.targetText;
  next.timing = patch.timing ?? (moved ? 'manual' : prev.timing);
  next.flags = patch.flags ?? (moved || retext ? flagsAfterEdit(prev, next) : prev.flags);
  const unchanged = !moved && !retext && next.timing === prev.timing && sameFlags(next.flags, prev.flags);
  return unchanged ? prev : next;
}

/** Thao tác trả một cue về giá trị cũ; luôn kèm kiểu mốc và cờ để không bị suy ra lại. */
function revert(prev: Cue, next: Cue): CueOp {
  const patch: CuePatch = { timing: prev.timing, flags: prev.flags };
  if (next.startMs !== prev.startMs) patch.startMs = prev.startMs;
  if (next.endMs !== prev.endMs) patch.endMs = prev.endMs;
  if (next.sourceText !== prev.sourceText) patch.sourceText = prev.sourceText;
  if (next.targetText !== prev.targetText) patch.targetText = prev.targetText;
  return { type: 'update', id: prev.id, patch };
}

const badText = (s: string) => s.includes('\u0000') || (s.length > CUE_LIMITS.maxTextChars && [...s].length > CUE_LIMITS.maxTextChars);

function invalid(c: Cue, durationMs: number): CueViolationReason | null {
  if (!Number.isInteger(c.startMs) || !Number.isInteger(c.endMs) || c.startMs < 0) return 'range';
  if (c.endMs - c.startMs < MIN) return 'too_short';
  if (c.endMs > durationMs) return 'past_end';
  return badText(c.sourceText) || badText(c.targetText) ? 'text' : null;
}

export const byStart = (a: Cue, b: Cue): number => a.startMs - b.startMs || a.endMs - b.endMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Áp dụng cả lô hoặc không gì cả. Chỉ trạng thái cuối được kiểm, và chỉ với cue bị đụng tới (một cue cũ sai sẵn không chặn việc sửa
 * cue khác).
 */
export function applyOps(cues: readonly Cue[], ops: readonly CueOp[], durationMs: number): ApplyResult {
  const map = new Map(cues.map((c) => [c.id, c]));
  const originals = new Set(map.keys());
  const touched = new Set<string>();
  const inverse: CueOp[] = [];
  const fail = (id: string, reason: CueViolationReason): ApplyResult => ({ ok: false, violation: { id, reason } });

  for (const op of ops) {
    if (op.type === 'insert') {
      if (map.has(op.cue.id)) return fail(op.cue.id, 'duplicate');
      const cue = { ...op.cue, sourceText: op.cue.sourceText.normalize('NFC'), targetText: op.cue.targetText.normalize('NFC') };
      map.set(cue.id, cue);
      touched.add(cue.id);
      inverse.push({ type: 'delete', id: cue.id });
      continue;
    }
    const prev = map.get(op.id);
    if (!prev) return fail(op.id, 'missing');
    if (op.type === 'delete') {
      map.delete(op.id);
      touched.delete(op.id);
      inverse.push({ type: 'insert', cue: prev });
      continue;
    }
    const next = patched(prev, op.patch);
    if (next === prev) continue;
    map.set(op.id, next);
    touched.add(op.id);
    inverse.push(revert(prev, next));
  }

  if (map.size > CUE_LIMITS.maxCues) return fail([...touched][0] ?? '', 'too_many');
  const list = [...map.values()].sort(byStart);
  for (let i = 0; i < list.length; i++) {
    const c = list[i]!;
    const mine = touched.has(c.id);
    if (mine) {
      const reason = invalid(c, durationMs);
      if (reason) return fail(c.id, reason);
    }
    const next = list[i + 1];
    if (next && c.endMs > next.startMs && (mine || touched.has(next.id))) return fail(mine ? c.id : next.id, 'overlap');
  }
  return {
    ok: true,
    cues: list,
    inverse: inverse.reverse(),
    changed: list.filter((c) => touched.has(c.id)),
    removed: [...originals].filter((id) => !map.has(id)),
  };
}

// ---- Chỉnh mốc ----------------------------------------------------------------------------------

export type Edge = 'start' | 'end';

/** Khoảng được phép của một mép: không vượt cue liền kề, cue vẫn dài ít nhất 100 ms, không ra ngoài video. */
export function edgeBounds(cues: readonly Cue[], index: number, edge: Edge, durationMs: number): { min: number; max: number } {
  const c = cues[index]!;
  return edge === 'start' ? { min: cues[index - 1]?.endMs ?? 0, max: c.endMs - MIN } : { min: c.startMs + MIN, max: cues[index + 1]?.startMs ?? durationMs };
}

/** Đặt một mép tới giá trị mong muốn, đã kẹp; `null` khi không có gì đổi. */
export function setEdgeOp(cues: readonly Cue[], id: string, edge: Edge, valueMs: number, durationMs: number): CueOp | null {
  const index = cues.findIndex((c) => c.id === id);
  if (index < 0 || !Number.isFinite(valueMs)) return null;
  const { min, max } = edgeBounds(cues, index, edge, durationMs);
  if (min > max) return null;
  const value = Math.min(max, Math.max(min, Math.round(valueMs)));
  const key = edge === 'start' ? 'startMs' : 'endMs';
  return value === cues[index]![key] ? null : { type: 'update', id, patch: { [key]: value } };
}

export function nudgeOp(cues: readonly Cue[], id: string, edge: Edge, deltaMs: number, durationMs: number): CueOp | null {
  const c = cues.find((x) => x.id === id);
  return c ? setEdgeOp(cues, id, edge, (edge === 'start' ? c.startMs : c.endMs) + deltaMs, durationMs) : null;
}

// ---- Gộp, tách, thêm ----------------------------------------------------------------------------

const joinText = (a: string, b: string): string => [a.trim(), b.trim()].filter(Boolean).join(' ');

/** Gộp cue với cue liền sau. */
export function mergeOps(cues: readonly Cue[], id: string): CueOp[] | null {
  const index = cues.findIndex((c) => c.id === id);
  const first = cues[index];
  const second = cues[index + 1];
  if (!first || !second) return null;
  return [
    { type: 'update', id, patch: { endMs: second.endMs, sourceText: joinText(first.sourceText, second.sourceText), targetText: joinText(first.targetText, second.targetText) } },
    { type: 'delete', id: second.id },
  ];
}

export type CueColumn = 'source' | 'target';
/** Vị trí con trỏ chữ trong một cột (đơn vị chỉ số chuỗi của ô nhập). */
export type Caret = { column: CueColumn; offset: number };

const weightOf = (text: string): number =>
  isUnspaced(text) ? graphemes(text.trim()).length : splitWords(text).reduce((n, w) => n + wordWeight(w), 0);

/** Chia chữ thành hai phần sao cho phần đầu chiếm gần đúng `ratio` trọng số, cắt ở ranh giới từ (chữ viết liền: ký tự). */
function splitByWeight(text: string, ratio: number): [string, string] {
  const unspaced = isUnspaced(text);
  const items = unspaced ? graphemes(text.trim()) : splitWords(text);
  if (items.length < 2) return [text.trim(), ''];
  const weights = items.map((x) => (unspaced ? 1 : wordWeight(x)));
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  let acc = 0;
  let best = 1;
  let bestGap = Number.POSITIVE_INFINITY;
  for (let k = 1; k < items.length; k++) {
    acc += weights[k - 1]!;
    const gap = Math.abs(acc / total - ratio);
    if (gap < bestGap) {
      best = k;
      bestGap = gap;
    }
  }
  const sep = unspaced ? '' : ' ';
  return [items.slice(0, best).join(sep), items.slice(best).join(sep)];
}

/**
 * Tách một cue thành hai. Mốc tách theo trọng số chữ ở hai bên con trỏ; không có con trỏ (hoặc con trỏ ở mép chữ) thì chia giữa.
 * `null` khi cue ngắn hơn 200 ms.
 */
export function splitOps(cues: readonly Cue[], id: string, newId: string, caret?: Caret): CueOp[] | null {
  const c = cues.find((x) => x.id === id);
  if (!c || c.endMs - c.startMs < MIN * 2) return null;
  const column: CueColumn = caret?.column ?? (c.targetText.trim() ? 'target' : 'source');
  const text = column === 'target' ? c.targetText : c.sourceText;
  let first = caret ? text.slice(0, Math.max(0, caret.offset)).trim() : '';
  let second = caret ? text.slice(Math.max(0, caret.offset)).trim() : '';
  if (!first || !second) [first, second] = splitByWeight(text, 0.5);
  const total = weightOf(first) + weightOf(second);
  const ratio = total > 0 && second ? weightOf(first) / total : 0.5;
  const at = Math.min(c.endMs - MIN, Math.max(c.startMs + MIN, Math.round(c.startMs + (c.endMs - c.startMs) * ratio)));
  const [otherFirst, otherSecond] = splitByWeight(column === 'target' ? c.sourceText : c.targetText, ratio);
  const sourceTexts = column === 'target' ? [otherFirst, otherSecond] : [first, second];
  const targetTexts = column === 'target' ? [first, second] : [otherFirst, otherSecond];
  const tail: Cue = { ...c, id: newId, startMs: at, timing: 'manual', sourceText: sourceTexts[1]!, targetText: targetTexts[1]!, flags: {} };
  if (c.flags.untranslated && !tail.targetText) tail.flags.untranslated = true;
  if (isFastText(tail.targetText, tail.endMs - tail.startMs)) tail.flags.fast = true;
  return [
    { type: 'update', id, patch: { endMs: at, sourceText: sourceTexts[0]!, targetText: targetTexts[0]! } },
    { type: 'insert', cue: tail },
  ];
}

/** Thêm một cue trống vào khoảng trống ngay sau `afterId` (`null` = trước cue đầu); `null` khi không đủ 100 ms. */
export function insertAfterOp(cues: readonly Cue[], afterId: string | null, newId: string, durationMs: number): CueOp | null {
  const index = afterId === null ? -1 : cues.findIndex((c) => c.id === afterId);
  if (afterId !== null && index < 0) return null;
  const startMs = cues[index]?.endMs ?? 0;
  const endMs = Math.min(startMs + NEW_CUE_MS, cues[index + 1]?.startMs ?? durationMs, durationMs);
  if (endMs - startMs < MIN) return null;
  return { type: 'insert', cue: { id: newId, startMs, endMs, timing: 'manual', sourceText: '', targetText: '', sourceLang: null, speaker: null, flags: {} } };
}

/** Chỉ số cue đang hiện tại `ms` (tìm nhị phân), -1 nếu rơi vào khoảng trống. */
export function cueIndexAt(cues: readonly Pick<Cue, 'startMs' | 'endMs'>[], ms: number): number {
  let low = 0;
  let high = cues.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (cues[mid]!.startMs <= ms) low = mid + 1;
    else high = mid - 1;
  }
  return high >= 0 && ms < cues[high]!.endMs ? high : -1;
}
