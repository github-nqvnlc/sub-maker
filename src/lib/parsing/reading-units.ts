import { charLen } from './normalize';
import { splitLongSentence } from './segmenter';

/**
 * Đơn vị đọc (spec 003, FR-007): một câu gồm một hoặc nhiều cue liên tiếp — là đơn vị gửi tới giọng đọc,
 * đơn vị của bộ nhớ đệm và của `job_segments`. Hàm thuần, xác định: cùng đầu vào ⇒ cùng đơn vị,
 * nên tiếp tục tiến trình không cần lưu lại danh sách đơn vị (contracts/timing-engine.md §1).
 */

export type ReadingCue = { idx: number; n: number; startMs: number; endMs: number; text: string; speakable: boolean };

export type ReadingUnit = {
  idx: number;
  /** chỉ số (idx) của cue đầu và cue cuối của đơn vị */
  cueFrom: number;
  cueTo: number;
  /** các cue thuộc đơn vị, theo thứ tự (dùng để chia mốc nội bộ theo tỷ lệ ký tự) */
  cues: Array<{ idx: number; n: number; text: string }>;
  text: string;
  /** mốc bắt đầu của cue đầu */
  startMs: number;
  /** mốc kết thúc của cue cuối (khe thời gian của đơn vị) */
  slotEndMs: number;
  chars: number;
  /** true khi đơn vị là một mảnh của cue quá dài đã tách theo mệnh đề */
  split?: boolean;
};

export type ReadingUnitOptions = {
  merge: boolean;
  /** giới hạn ký tự của một yêu cầu tới nhà cung cấp */
  maxChars: number;
  /** khoảng nghỉ tối đa giữa hai cue liền nhau vẫn được ghép chung */
  maxGapMs: number;
};

const CLOSERS = new Set(['"', "'", '”', '’', ')', ']', '»']);
const SENTENCE_END = new Set(['.', '?', '!', '…', ':']);

/** Cue kết thúc một câu (dấu . ? ! … hoặc :), bỏ qua ngoặc/nháy đóng ở cuối. */
export function endsSentence(text: string): boolean {
  const chars = [...text.trimEnd()];
  while (chars.length > 0 && CLOSERS.has(chars[chars.length - 1]!)) chars.pop();
  const last = chars[chars.length - 1];
  return last !== undefined && SENTENCE_END.has(last);
}

export function buildReadingUnits(cues: readonly ReadingCue[], opts: ReadingUnitOptions): ReadingUnit[] {
  const units: ReadingUnit[] = [];
  let group: ReadingCue[] = [];

  const flush = () => {
    if (group.length === 0) return;
    const first = group[0]!;
    const last = group[group.length - 1]!;
    const text = group.map((c) => c.text).join(' ');
    const groupCues = group.map((c) => ({ idx: c.idx, n: c.n, text: c.text }));
    if (charLen(text) <= opts.maxChars) {
      units.push({
        idx: units.length,
        cueFrom: first.idx,
        cueTo: last.idx,
        cues: groupCues,
        text,
        startMs: first.startMs,
        slotEndMs: last.endMs,
        chars: charLen(text),
      });
    } else {
      // Quá dài cho một yêu cầu → tách theo mệnh đề; thời gian chia theo tỷ lệ ký tự trên cả khe
      const pieces = splitLongSentence(text, opts.maxChars);
      const total = pieces.reduce((n, p) => n + charLen(p), 0) || 1;
      const span = last.endMs - first.startMs;
      let acc = 0;
      for (const piece of pieces) {
        const len = charLen(piece);
        const start = first.startMs + Math.round((span * acc) / total);
        acc += len;
        const end = first.startMs + Math.round((span * acc) / total);
        units.push({
          idx: units.length,
          cueFrom: first.idx,
          cueTo: last.idx,
          cues: groupCues,
          text: piece,
          startMs: start,
          slotEndMs: Math.max(end, start + 1),
          chars: len,
          split: true,
        });
      }
    }
    group = [];
  };

  for (const cue of cues) {
    if (!cue.speakable) {
      flush(); // cue im lặng ngắt nhóm và không thuộc đơn vị nào
      continue;
    }
    if (opts.merge && group.length > 0) {
      const prev = group[group.length - 1]!;
      const gap = cue.startMs - prev.endMs;
      const joined = group.map((c) => c.text).join(' ') + ' ' + cue.text;
      if (gap > opts.maxGapMs || charLen(joined) > opts.maxChars) flush();
    }
    group.push(cue);
    if (!opts.merge || endsSentence(cue.text)) flush();
  }
  flush();
  return units;
}
