import { FRAME_MS } from './frames';
import type { AppliedCue, OverlayWarning } from './types';

/**
 * Mốc áp dụng của câu (FR-004, FR-005; overlay-engine §2, research R7). Hàm thuần, tất định.
 * Voice khớp mốc tạo từ chính tệp phụ đề thì dùng mốc đọc thật; các trường hợp khác dùng mốc trong tệp.
 */

export type TimingSource = 'timed' | 'continuous' | 'otherFile' | 'uploaded';

export type FileCue = { startMs: number; endMs: number; text: string; speakable: boolean };
export type VoiceEntry = { startMs: number; endMs: number; text?: string; failed?: boolean };

export type TimingInput = {
  fileCues: readonly FileCue[];
  source: TimingSource;
  /** `voices.timeline`; chỉ dùng khi `source = 'timed'` */
  voiceTimeline?: readonly VoiceEntry[] | null;
  voiceDurationMs: number;
};

export type TimingResult = { cues: AppliedCue[]; warnings: OverlayWarning[] };

/** Lệch thời lượng voice và phụ đề quá mức này thì cảnh báo (FR-005). */
export const LENGTH_TOLERANCE_MS = 2000;
/** Câu bị cắt ít hơn mức này coi như không bị cắt (làm tròn thời lượng MP3). */
const CUT_TOLERANCE_MS = 100;

const compact = (s: string): string[] => [...s.normalize('NFC').replace(/\s+/gu, '')];

type RawMark = { startMs: number; readEndMs: number; origin: 'voice' | 'file' };
type VoiceSlot = { from: number; len: number; e: VoiceEntry };

/**
 * Ghép theo chuỗi chữ bỏ khoảng trắng: nối chữ của mọi mục timeline (kể cả mục bị tách hoặc `failed`) phải bằng nối chữ của mọi
 * cue có chữ. Không bằng → null (người gọi lùi về mốc tệp). Mỗi cue ứng với một dải ký tự; mốc nội suy theo ký tự trong mục chứa nó.
 */
function marksFromVoice(cues: readonly FileCue[], timeline: readonly VoiceEntry[]): RawMark[] | null {
  const slots: VoiceSlot[] = [];
  const voiceChars: string[] = [];
  for (const e of timeline) {
    const chars = compact(e.text ?? '');
    if (chars.length === 0) continue;
    slots.push({ from: voiceChars.length, len: chars.length, e });
    for (const ch of chars) voiceChars.push(ch);
  }
  const cueChars = cues.map((c) => compact(c.text));
  const total = cueChars.reduce((n, c) => n + c.length, 0);
  if (total === 0 || total !== voiceChars.length) return null;
  let at = 0;
  for (const chars of cueChars) for (const ch of chars) if (ch !== voiceChars[at++]) return null;

  const timeAt = (slot: VoiceSlot, offset: number) => slot.e.startMs + ((slot.e.endMs - slot.e.startMs) * (offset - slot.from)) / slot.len;

  const marks: RawMark[] = [];
  let k = 0;
  let off = 0;
  for (let i = 0; i < cues.length; i++) {
    const a = off;
    const b = off + cueChars[i]!.length;
    off = b;
    // đầu dải trùng ranh giới thì lấy mục sau
    while (slots[k]!.from + slots[k]!.len <= a) k++;
    let last = k;
    let failed = !!slots[k]!.e.failed;
    while (slots[last]!.from + slots[last]!.len < b) {
      last++;
      failed ||= !!slots[last]!.e.failed;
    }
    const c = cues[i]!;
    if (failed) marks.push({ startMs: c.startMs, readEndMs: c.endMs, origin: 'file' });
    else marks.push({ startMs: Math.round(timeAt(slots[k]!, a)), readEndMs: Math.round(timeAt(slots[last]!, b)), origin: 'voice' });
  }
  return marks;
}

export function applyTiming(input: TimingInput): TimingResult {
  const { source, voiceDurationMs } = input;
  const warnings: OverlayWarning[] = [];
  const spoken = input.fileCues.filter((c) => c.speakable && c.text.trim() !== '');

  if (source === 'continuous') warnings.push({ code: 'NOT_TIMED_VOICE' });
  if (source === 'otherFile') warnings.push({ code: 'OTHER_FILE' });

  const fromFile = (): RawMark[] => spoken.map((c) => ({ startMs: c.startMs, readEndMs: c.endMs, origin: 'file' as const }));
  let marks: RawMark[];
  if (source === 'timed' && input.voiceTimeline) {
    const m = spoken.length > 0 ? marksFromVoice(spoken, input.voiceTimeline) : [];
    if (!m) warnings.push({ code: 'TIMELINE_FALLBACK' });
    marks = m ?? fromFile();
  } else marks = fromFile();

  // Kẹp thứ tự: cue dùng mốc voice có thể trễ hơn cue dùng mốc tệp đứng sau nó
  const starts: number[] = [];
  for (let i = 0; i < marks.length; i++) {
    const raw = Math.max(0, marks[i]!.startMs);
    starts.push(i === 0 ? raw : Math.max(raw, starts[i - 1]! + FRAME_MS));
  }

  const cues: AppliedCue[] = [];
  let dropped = 0;
  let cut = 0;
  for (let i = 0; i < marks.length; i++) {
    const startMs = starts[i]!;
    if (startMs >= voiceDurationMs) {
      dropped++;
      continue;
    }
    const natural = Math.max(marks[i]!.readEndMs, spoken[i]!.endMs, startMs + FRAME_MS);
    const next = i + 1 < starts.length ? starts[i + 1]! : Number.POSITIVE_INFINITY;
    const endMs = Math.min(natural, next, voiceDurationMs);
    if (Math.min(natural, next) - voiceDurationMs > CUT_TOLERANCE_MS) cut++;
    const readEndMs = Math.min(endMs, Math.max(startMs + 1, marks[i]!.readEndMs));
    cues.push({
      i: cues.length,
      startMs,
      endMs,
      readEndMs,
      text: spoken[i]!.text.normalize('NFC').replace(/\s+/gu, ' ').trim(),
      origin: marks[i]!.origin,
    });
  }

  const lastEnd = input.fileCues.reduce((m, c) => Math.max(m, c.endMs), 0);
  const diffMs = voiceDurationMs - lastEnd;
  if (dropped > 0 || cut > 0 || Math.abs(diffMs) > LENGTH_TOLERANCE_MS) {
    warnings.push({ code: 'LENGTH_MISMATCH', params: { diffMs, droppedCues: dropped, cutCues: cut } });
  }
  return { cues, warnings };
}

/** Cue đang hiện tại thời điểm `tMs` (chỉ số trong mảng) hoặc -1. Các cue tăng dần, không chồng lấn. */
export function activeCueIndex(cues: readonly AppliedCue[], tMs: number): number {
  let lo = 0;
  let hi = cues.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid]!.startMs <= tMs) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans >= 0 && tMs < cues[ans]!.endMs ? ans : -1;
}
