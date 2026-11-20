import { SAMPLE_RATE } from './pcm';

/**
 * Đặt các đơn vị đọc vào đúng mốc phụ đề (spec 003, FR-004/FR-006). Hàm THUẦN, không I/O; mọi phép tính theo
 * SỐ MẪU PCM nguyên (xác định, không tích lũy sai số). Thuật toán và bất biến I1–I10: contracts/timing-engine.md.
 *
 * Thứ tự xử lý khi lời đọc dài hơn khe: (1) mượn khoảng nghỉ liền sau, (2) nén nhẹ ≤ maxCompress,
 * (3) vẫn tràn ⇒ đơn vị kế TRƯỢT nhẹ và tự bù ở khoảng nghỉ sau; vượt maxSlip thì đánh dấu overflow.
 */

export type PlaceUnit = { idx: number; startMs: number; slotEndMs: number };
export type AudioInfo = { idx: number; samples: number };
export type PlaceParams = { maxSlipMs: number; maxCompress: number; minGapMs: number };
export const DEFAULT_PLACE_PARAMS: PlaceParams = { maxSlipMs: 500, maxCompress: 1.25, minGapMs: 60 };

export type Placed = {
  idx: number;
  startSample: number;
  /** số mẫu sau khi nén (độ dài ghi vào voice) */
  outSamples: number;
  /** số mẫu gốc trước khi nén */
  inSamples: number;
  compress: number;
  slipMs: number;
  overflow: boolean;
};
export type Placement = { placed: Placed[]; totalSamples: number };

export type PartUnit = { idx: number; startMs: number; slotEndMs: number };
export type Part = { n: number; fromUnit: number; toUnit: number; startMs: number; endMs: number };

/**
 * Chia phụ đề dài thành các PHẦN theo cửa sổ thời gian (spec 003, FR-012; contracts/timing-engine.md §3).
 * Điểm cắt gần mỗi mốc k·windowMs (±20% cửa sổ) được chọn ở KHOẢNG NGHỈ LỚN NHẤT giữa hai đơn vị liền nhau; không có khoảng
 * nghỉ nào trong dải thì cắt tại ranh giới đơn vị gần mốc nhất. Một đơn vị không bao giờ bị cắt đôi. Xác định, thuần.
 * Phần chỉ phục vụ log, tiến độ và điểm đặt lại độ trễ; việc ghép vẫn là một lượt ghi tuần tự theo mốc tuyệt đối.
 */
export function planParts(units: readonly PartUnit[], windowMs: number): Part[] {
  const n = units.length;
  if (n === 0) return [];
  const cuts: number[] = []; // b: phần kết thúc ở đơn vị b (cắt giữa b và b+1)
  const slack = windowMs * 0.2;
  const lastStart = units[n - 1]!.startMs;
  // chỉ số nhỏ nhất i ≥ 1 sao cho units[i].startMs ≥ ms
  const lowerBound = (ms: number): number => {
    let lo = 1;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (units[mid]!.startMs >= ms) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  };
  for (let k = 1; k * windowMs < lastStart; k++) {
    const target = k * windowMs;
    const prev = cuts.length > 0 ? cuts[cuts.length - 1]! : -1;
    let best = -1;
    let bestGap = -1;
    let bestDist = Number.POSITIVE_INFINITY;
    for (let i = lowerBound(target - slack); i < n && units[i]!.startMs <= target + slack; i++) {
      const b = i - 1;
      if (b <= prev) continue;
      const gap = units[i]!.startMs - units[b]!.slotEndMs;
      const dist = Math.abs(units[i]!.startMs - target);
      if (gap > bestGap || (gap === bestGap && dist < bestDist)) {
        best = b;
        bestGap = gap;
        bestDist = dist;
      }
    }
    if (best < 0) {
      // không có ranh giới trong dải: chọn ranh giới gần mốc nhất (nhưng sau điểm cắt trước)
      let i = Math.min(n - 1, Math.max(1, lowerBound(target)));
      if (i > 1 && Math.abs(units[i - 1]!.startMs - target) < Math.abs(units[i]!.startMs - target)) i -= 1;
      if (i - 1 > prev && i < n) best = i - 1;
    }
    if (best >= 0) cuts.push(best);
  }
  const parts: Part[] = [];
  let from = 0;
  for (const b of [...cuts, n - 1]) {
    parts.push({ n: parts.length + 1, fromUnit: from, toUnit: b, startMs: units[from]!.startMs, endMs: units[b]!.slotEndMs });
    from = b + 1;
  }
  return parts;
}

export const msToSamples = (ms: number): number => Math.round((ms * SAMPLE_RATE) / 1000);
export const samplesToMs = (samples: number): number => Math.round((samples * 1000) / SAMPLE_RATE);

/**
 * `units` theo thứ tự; `audio` chứa các đơn vị CÓ audio. Đơn vị không có audio (đoạn bị chặn nội dung, I9) bị bỏ qua:
 * khe của nó là im lặng và không gây trượt.
 */
export function placeUnits(units: readonly PlaceUnit[], audio: readonly AudioInfo[], params: PlaceParams = DEFAULT_PLACE_PARAMS): Placement {
  const samplesByIdx = new Map(audio.map((a) => [a.idx, a.samples]));
  const withAudio = units.filter((u) => samplesByIdx.has(u.idx));
  const minGap = msToSamples(params.minGapMs);
  const placed: Placed[] = [];
  let cursor = -minGap; // đơn vị đầu không bị cộng khoảng cách tối thiểu (I8)

  for (let i = 0; i < withAudio.length; i++) {
    const u = withAudio[i]!;
    const need = samplesByIdx.get(u.idx)!;
    const S = msToSamples(u.startMs);
    const next = withAudio[i + 1];
    const Snext = next ? msToSamples(next.startMs) : Number.POSITIVE_INFINITY;

    const start = Math.max(S, cursor + minGap);
    const slipSamples = start - S;
    const avail = Snext === Number.POSITIVE_INFINITY ? Number.POSITIVE_INFINITY : Snext - minGap - start;

    let out = need;
    let compress = 1;
    if (need > avail) {
      const f = avail > 0 ? need / avail : Number.POSITIVE_INFINITY;
      if (f <= params.maxCompress) {
        out = avail; // nén vừa khít khoảng khả dụng
        compress = need / avail;
      } else {
        compress = params.maxCompress;
        out = Math.ceil(need / compress); // không cắt cụt lời (I6); phần tràn thành độ trễ của đơn vị kế
      }
    }
    cursor = start + out;
    const slipMs = Math.round((slipSamples * 1000) / SAMPLE_RATE);
    placed.push({ idx: u.idx, startSample: start, outSamples: out, inSamples: need, compress, slipMs, overflow: slipMs > params.maxSlipMs });
  }
  const last = placed[placed.length - 1];
  return { placed, totalSamples: last ? last.startSample + last.outSamples : 0 };
}
