import { charLen, hasSpeakable, normalizeInline } from './normalize';

/**
 * Phụ đề .srt (SubRip): các cue gồm số thứ tự + dòng mốc thời gian + chữ.
 * - `srtToParagraphs` (chế độ "Đọc liên tục"): mốc thời gian bị BỎ QUA; thời lượng thật lấy từ audio sinh ra.
 *   Mỗi "cue" (các dòng chữ giữa hai dòng trống) thành MỘT đoạn.
 * - `parseSrtCues` (chế độ khớp mốc, spec 003): giữ mốc, chuẩn hóa cue bất thường và báo cảnh báo.
 */

const TIMECODE = /^\s*(?:\d{1,2}:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?\s*-->\s*(?:\d{1,2}:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?.*$/;
const CUE_INDEX = /^\s*\d{1,6}\s*$/;
const BRACKET_TIME = /^\s*\[\s*(?:\d{1,2}:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?\s*\]\s*/;

function cleanLine(line: string): string {
  return line
    .replace(BRACKET_TIME, '') // [00:01:05] ở đầu dòng
    .replace(/<[^>\n]{1,80}>/g, '') // <i>, <font color=...>, <c.colorE5E5E5>
    .replace(/\{\\?[^}\n]{1,80}\}/g, '') // {\an8}, {italic}
    .trim();
}

export function srtToParagraphs(text: string): string[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const paragraphs: string[] = [];
  let cue: string[] = [];

  const flush = () => {
    const joined = cue.join(' ').replace(/\s+/g, ' ').trim();
    if (joined) paragraphs.push(joined);
    cue = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const trimmed = raw.trim();
    if (trimmed === '' ) {
      flush();
      continue;
    }
    if (/^WEBVTT\b/i.test(trimmed) && paragraphs.length === 0 && cue.length === 0) continue;
    if (TIMECODE.test(raw)) continue;
    // Dòng chỉ có số là chỉ số cue khi dòng kế tiếp là mốc thời gian
    if (CUE_INDEX.test(raw) && i + 1 < lines.length && TIMECODE.test(lines[i + 1]!)) {
      flush();
      continue;
    }
    const cleaned = cleanLine(raw);
    if (cleaned) cue.push(cleaned);
  }
  flush();
  return paragraphs;
}

// ---- Chế độ khớp mốc thời gian (spec 003) ----------------------------------------------------------

export type CueWarningCode = 'BAD_RANGE' | 'OUT_OF_ORDER' | 'OVERLAP' | 'NO_SPEECH';
export type CueWarning = { cue: number; code: CueWarningCode };
export type SrtCue = { idx: number; n: number; startMs: number; endMs: number; text: string; speakable: boolean; charCount: number };
export type ParsedCues = { cues: SrtCue[]; warnings: CueWarning[]; warningCount: number };

/** Số cảnh báo tối đa trả về/lưu; số thật nằm ở `warningCount`. */
export const MAX_CUE_WARNINGS = 200;

const TIME_RE = /^\s*((?:\d{1,2}:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?)\s*-->\s*((?:\d{1,2}:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?)/;
/** Cả chuỗi chỉ là chú thích trong ngoặc, ví dụ "[Music]", "(cười)" → không đọc. */
const ANNOTATION_ONLY = /^\s*(?:\[[^\]]*\]|\([^)]*\)|（[^）]*）|【[^】]*】)\s*$/u;

/** "hh:mm:ss,mmm" | "mm:ss.mmm" → mili giây. */
export function parseTimeMs(t: string): number {
  const [main = '0:00', frac = ''] = t.replace(',', '.').split('.');
  const parts = main.split(':').map(Number);
  const [h, m, sec] = parts.length === 3 ? [parts[0]!, parts[1]!, parts[2]!] : [0, parts[0]!, parts[1]!];
  return ((h * 60 + m) * 60 + sec) * 1000 + Number((frac + '000').slice(0, 3));
}

type RawCue = { n: number; startMs: number; endMs: number; text: string };

/**
 * Phân tích các cue của tệp .srt và chuẩn hóa (research R1): số thứ tự và dòng mốc không nằm trong chữ đọc;
 * mốc ngược/bằng → bỏ (BAD_RANGE); ngoài thứ tự → sắp lại (OUT_OF_ORDER); chồng lấn → giới hạn bởi mốc cue sau
 * (OVERLAP); không có chữ đọc (♪, [Music]) → giữ khe im lặng, không gửi nhà cung cấp (NO_SPEECH).
 */
export function parseSrtCues(input: string): ParsedCues {
  const lines = input.replace(/\r\n?/g, '\n').split('\n');
  const warnings: CueWarning[] = [];
  let warningCount = 0;
  const warn = (cue: number, code: CueWarningCode) => {
    warningCount += 1;
    if (warnings.length < MAX_CUE_WARNINGS) warnings.push({ cue, code });
  };

  const raw: RawCue[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = TIME_RE.exec(lines[i]!);
    if (!m) continue;
    const prev = i > 0 ? lines[i - 1]! : '';
    const n = CUE_INDEX.test(prev) ? Number(prev.trim()) : raw.length + 1;
    const text: string[] = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const line = lines[j]!;
      if (line.trim() === '') break;
      // cue kế tiếp bắt đầu mà không có dòng trống: dòng số + dòng mốc
      if (CUE_INDEX.test(line) && j + 1 < lines.length && TIME_RE.test(lines[j + 1]!)) break;
      const cleaned = cleanLine(line);
      if (cleaned) text.push(cleaned);
    }
    let joined = normalizeInline(text.join(' '));
    if (ANNOTATION_ONLY.test(joined)) joined = '';
    raw.push({ n, startMs: parseTimeMs(m[1]!), endMs: parseTimeMs(m[2]!), text: joined });
    i = j - 1;
  }

  // 1) mốc ngược/bằng → bỏ
  const valid: RawCue[] = [];
  for (const c of raw) {
    if (c.endMs <= c.startMs) warn(c.n, 'BAD_RANGE');
    else valid.push(c);
  }

  // 2) ngoài thứ tự → sắp ổn định theo mốc bắt đầu
  let maxStart = -1;
  for (const c of valid) {
    if (c.startMs < maxStart) warn(c.n, 'OUT_OF_ORDER');
    maxStart = Math.max(maxStart, c.startMs);
  }
  const sorted = valid.map((c, k) => ({ c, k })).sort((a, b) => a.c.startMs - b.c.startMs || a.k - b.k).map((x) => x.c);

  // 3) chồng lấn → khe bị giới hạn bởi mốc bắt đầu cue sau
  const limited: RawCue[] = [];
  for (let k = 0; k < sorted.length; k++) {
    const c = { ...sorted[k]! };
    const next = sorted[k + 1];
    if (next && c.endMs > next.startMs) {
      if (next.startMs <= c.startMs) {
        warn(c.n, 'BAD_RANGE');
        continue;
      }
      c.endMs = next.startMs;
      warn(c.n, 'OVERLAP');
    }
    limited.push(c);
  }

  // 4) không có chữ đọc → im lặng
  const cues: SrtCue[] = limited.map((c, idx) => {
    const speakable = hasSpeakable(c.text);
    if (!speakable) warn(c.n, 'NO_SPEECH');
    const text = speakable ? c.text : '';
    return { idx, n: c.n, startMs: c.startMs, endMs: c.endMs, text, speakable, charCount: charLen(text) };
  });
  return { cues, warnings, warningCount };
}
