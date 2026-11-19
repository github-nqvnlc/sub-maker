import { BYTES_PER_SAMPLE, SAMPLE_RATE } from './ffmpeg';

/**
 * Ghép PCM các đoạn theo thứ tự, chèn khoảng lặng theo dấu câu cuối đoạn, và tính mốc thời gian
 * từng đoạn THEO SỐ MẪU PCM (chính xác, không phụ thuộc bộ mã hóa MP3) — nền tảng của highlight đồng bộ
 * (research R7/R11, SC-004).
 */

export type Pauses = {
  /** Sau . ! ? … (mặc định 380 ms) */
  sentence: number;
  /** Sau , ; : (mặc định 220 ms) */
  comma: number;
  /** Đoạn kết thúc không có dấu câu, ví dụ tiêu đề (mặc định 300 ms) */
  other: number;
};

export const DEFAULT_PAUSES: Pauses = { sentence: 380, comma: 220, other: 300 };

export type TimelineEntry = { idx: number; startMs: number; endMs: number };

export type MergePart = { idx: number; pcm: Buffer; text: string };

/** Dấu câu cuối cùng của đoạn (bỏ qua ngoặc/nháy đóng). */
export function pauseAfter(text: string, pauses: Pauses = DEFAULT_PAUSES): number {
  const trimmed = text.trimEnd().replace(/["'”’)\]»]+$/u, '');
  const last = [...trimmed].at(-1) ?? '';
  if ('.!?…'.includes(last)) return pauses.sentence;
  if (',;:'.includes(last)) return pauses.comma;
  return pauses.other;
}

const msToSamples = (ms: number) => Math.round((ms * SAMPLE_RATE) / 1000);
const samplesToMs = (samples: number) => Math.round((samples * 1000) / SAMPLE_RATE);

/**
 * Bộ dựng mốc thời gian TĂNG DẦN: dùng khi ghép từng đoạn một và ghi tuần tự ra tệp (kịch bản dài không cần
 * giữ toàn bộ PCM trong bộ nhớ). Mọi phép tính theo SỐ MẪU, chỉ đổi sang ms ở bước cuối nên không tích lũy sai số.
 */
export class TimelineBuilder {
  readonly timeline: TimelineEntry[] = [];
  private cursor = 0; // đơn vị: mẫu
  private prevText: string | null = null;

  constructor(private readonly pauses: Pauses = DEFAULT_PAUSES) {}

  /**
   * Thêm một đoạn gồm `samples` mẫu. Trả về số mẫu IM LẶNG phải ghi TRƯỚC đoạn này
   * (khoảng nghỉ theo dấu câu cuối của đoạn trước; 0 với đoạn đầu tiên).
   */
  add(idx: number, samples: number, text: string): { gapSamples: number } {
    let gapSamples = 0;
    if (this.prevText !== null) {
      gapSamples = msToSamples(pauseAfter(this.prevText, this.pauses));
      this.cursor += gapSamples;
    }
    const start = this.cursor;
    this.cursor += samples;
    this.timeline.push({ idx, startMs: samplesToMs(start), endMs: samplesToMs(this.cursor) });
    this.prevText = text;
    return { gapSamples };
  }

  get totalSamples(): number {
    return this.cursor;
  }

  get durationMs(): number {
    return samplesToMs(this.cursor);
  }
}

export function mergePcm(
  parts: MergePart[],
  pauses: Pauses = DEFAULT_PAUSES,
): { pcm: Buffer; timeline: TimelineEntry[]; durationMs: number } {
  const builder = new TimelineBuilder(pauses);
  const chunks: Buffer[] = [];
  for (const part of parts) {
    if (part.pcm.length % BYTES_PER_SAMPLE !== 0) throw new Error(`PCM của đoạn ${part.idx} có độ dài lẻ`);
    const { gapSamples } = builder.add(part.idx, part.pcm.length / BYTES_PER_SAMPLE, part.text);
    if (gapSamples > 0) chunks.push(Buffer.alloc(gapSamples * BYTES_PER_SAMPLE)); // im lặng
    chunks.push(part.pcm);
  }
  return { pcm: Buffer.concat(chunks), timeline: builder.timeline, durationMs: builder.durationMs };
}
