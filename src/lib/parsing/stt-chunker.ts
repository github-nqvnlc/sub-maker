import type { SonioxToken } from '../providers/adapters/soniox-types';

/**
 * Gom token của Soniox thành phụ đề (spec 004, FR-004, research R3). Hàm thuần, không I/O.
 *
 * Token của Soniox là mảnh DƯỚI TỪ ("Hel", "lo", " world"): ranh giới từ là token mở đầu bằng khoảng trắng.
 * Quy tắc cue:
 *  - tối đa 75 ký tự, thời lượng tối đa 5,5 giây;
 *  - ngắt khi khoảng lặng giữa hai từ ≥ 380 ms, khi đổi người nói, hoặc sau dấu kết câu (. ! ? …);
 *  - ngắt ưu tiên sau dấu ngắt nhịp (, ; :) khi cue đã đủ dài;
 *  - cue ngắn hơn 1,2 giây được kéo dài phần cuối (không chồng lên cue sau).
 */

export const CUE_MAX_CHARS = 75;
export const CUE_MAX_MS = 5_500;
export const CUE_MIN_MS = 1_200;
export const SILENCE_GAP_MS = 380;
/** Cue đã dài ít nhất ngần này ký tự thì ngắt sau dấu phẩy/chấm phẩy/hai chấm. */
const SOFT_BREAK_CHARS = 40;

export type SttWord = { text: string; startMs: number; endMs: number; speaker?: string };
export type SttCue = { idx: number; startMs: number; endMs: number; text: string; speaker?: string };

const SENTENCE_END = /[.!?…。！？]["')\]»”]*$/;
const SOFT_END = /[,;:，；：]["')\]»”]*$/;

/** Bỏ token sự kiện âm thanh và token bản dịch; giữ token gốc. */
function speechTokens(tokens: SonioxToken[]): SonioxToken[] {
  return tokens.filter((t) => !t.is_audio_event && t.translation_status !== 'translation' && typeof t.text === 'string');
}

/** Ghép token dưới-từ thành từ (theo khoảng trắng đầu token). */
export function tokensToWords(tokens: SonioxToken[]): SttWord[] {
  const words: SttWord[] = [];
  let cur: SttWord | null = null;
  for (const t of speechTokens(tokens)) {
    const raw = t.text.normalize('NFC');
    const startsWord = cur === null || /^\s/.test(raw) || (cur.speaker ?? null) !== (t.speaker ?? null);
    const piece = raw.replace(/\s+/g, ' ');
    if (startsWord) {
      if (cur && cur.text.trim()) words.push({ ...cur, text: cur.text.trim() });
      cur = { text: piece, startMs: t.start_ms, endMs: t.end_ms, speaker: t.speaker };
    } else {
      cur!.text += piece;
      cur!.endMs = Math.max(cur!.endMs, t.end_ms);
    }
  }
  if (cur && cur.text.trim()) words.push({ ...cur, text: cur.text.trim() });
  return words.filter((w) => w.text.length > 0);
}

const joinWords = (ws: SttWord[]) => ws.map((w) => w.text).join(' ');

/** Gom từ thành cue theo các quy tắc ở đầu tệp. */
export function wordsToCues(words: SttWord[]): SttCue[] {
  const cues: SttCue[] = [];
  let cur: SttWord[] = [];
  const flush = () => {
    if (cur.length === 0) return;
    cues.push({ idx: cues.length, startMs: cur[0]!.startMs, endMs: cur[cur.length - 1]!.endMs, text: joinWords(cur), speaker: cur[0]!.speaker });
    cur = [];
  };

  for (const w of words) {
    if (cur.length > 0) {
      const prev = cur[cur.length - 1]!;
      const gap = w.startMs - prev.endMs;
      const nextText = `${joinWords(cur)} ${w.text}`;
      const speakerChanged = (prev.speaker ?? null) !== (w.speaker ?? null);
      if (speakerChanged || gap >= SILENCE_GAP_MS || [...nextText].length > CUE_MAX_CHARS || w.endMs - cur[0]!.startMs > CUE_MAX_MS) {
        flush();
      }
    }
    cur.push(w);
    const len = [...joinWords(cur)].length;
    if (SENTENCE_END.test(w.text) || (SOFT_END.test(w.text) && len >= SOFT_BREAK_CHARS)) flush();
  }
  flush();

  // Thời lượng tối thiểu: kéo dài phần cuối nhưng không chồng lên cue kế tiếp
  for (let i = 0; i < cues.length; i++) {
    const c = cues[i]!;
    if (c.endMs <= c.startMs) c.endMs = c.startMs + 1;
    if (c.endMs - c.startMs < CUE_MIN_MS) {
      const limit = i + 1 < cues.length ? cues[i + 1]!.startMs : Number.POSITIVE_INFINITY;
      c.endMs = Math.max(c.endMs, Math.min(c.startMs + CUE_MIN_MS, limit));
    }
  }
  return cues;
}

export function chunkTokensToCues(tokens: SonioxToken[]): SttCue[] {
  return wordsToCues(tokensToWords(tokens));
}

/** mili-giây → `HH:MM:SS,mmm` (SubRip). */
export function formatSrtTime(totalMs: number): string {
  const ms = Math.max(0, Math.round(totalMs));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const r = ms % 1000;
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(h)}:${p(m)}:${p(s)},${p(r, 3)}`;
}

/** Chuỗi `.srt` chuẩn SubRip (số thứ tự từ 1, dòng mốc thời gian, chữ, dòng trống). */
export function chunkTokensToSrt(tokens: SonioxToken[]): string {
  return cuesToSrt(chunkTokensToCues(tokens));
}

export function cuesToSrt(cues: SttCue[]): string {
  return cues.map((c, i) => `${i + 1}\n${formatSrtTime(c.startMs)} --> ${formatSrtTime(c.endMs)}\n${c.text}\n`).join('\n');
}

/** Gom từ thành đoạn văn: đoạn mới khi đổi người nói hoặc nghỉ dài (≥ 1,5 giây) sau một câu đã kết thúc. */
const PARAGRAPH_GAP_MS = 1_500;

type Paragraph = { speaker?: string; text: string };

function toParagraphs(words: SttWord[], bySpeaker: boolean): Paragraph[] {
  const out: Paragraph[] = [];
  let cur: SttWord[] = [];
  const flush = () => {
    if (cur.length) out.push({ speaker: cur[0]!.speaker, text: joinWords(cur) });
    cur = [];
  };
  for (const w of words) {
    const prev = cur[cur.length - 1];
    if (prev) {
      const speakerChanged = bySpeaker && (prev.speaker ?? null) !== (w.speaker ?? null);
      const pause = w.startMs - prev.endMs >= PARAGRAPH_GAP_MS && SENTENCE_END.test(prev.text);
      if (speakerChanged || pause) flush();
    }
    cur.push(w);
  }
  flush();
  return out;
}

/** `.txt`: văn bản thuần, các câu nối liền, xuống dòng giữa các đoạn nói. */
export function chunkTokensToTxt(tokens: SonioxToken[]): string {
  const paras = toParagraphs(tokensToWords(tokens), true);
  return paras.length ? `${paras.map((p) => p.text).join('\n\n')}\n` : '';
}

export type MdOptions = {
  title?: string;
  /** Có gắn nhãn người nói không (bật Speaker Diarization) */
  diarization?: boolean;
  /** Nhãn người nói theo ngôn ngữ giao diện, ví dụ (n) => `Người nói ${n}` */
  speakerLabel?: (n: number) => string;
};

/** `.md`: tiêu đề + các đoạn; khi bật diarization mỗi đoạn mở đầu bằng `**Người nói N**:`. */
export function chunkTokensToMd(tokens: SonioxToken[], opts: MdOptions = {}): string {
  const words = tokensToWords(tokens);
  const paras = toParagraphs(words, !!opts.diarization);
  const label = opts.speakerLabel ?? ((n: number) => `Người nói ${n}`);
  // Đánh số người nói theo thứ tự xuất hiện (mã của Soniox có thể là "1", "2" hoặc chuỗi khác)
  const order = new Map<string, number>();
  const lines: string[] = [];
  if (opts.title) lines.push(`# ${opts.title}`, '');
  for (const p of paras) {
    if (opts.diarization && p.speaker != null) {
      if (!order.has(p.speaker)) order.set(p.speaker, order.size + 1);
      lines.push(`**${label(order.get(p.speaker)!)}**: ${p.text}`, '');
    } else {
      lines.push(p.text, '');
    }
  }
  return lines.join('\n').replace(/\n+$/, '\n');
}
