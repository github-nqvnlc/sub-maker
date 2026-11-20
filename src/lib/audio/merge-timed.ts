import { open } from 'node:fs/promises';
import { BYTES_PER_SAMPLE } from './ffmpeg';
import { msToSamples, placeUnits, samplesToMs, type PlaceParams } from './placement';
import { tempoPcm } from './tempo';
import { trimSilence } from './trim';
import type { TimelineCue, TimelineEntry } from '../db/schema/jobs';
import type { ReadingUnit } from '../parsing/reading-units';

/**
 * Ghép tuần tự các đơn vị đọc vào MỘT tệp PCM theo mốc tuyệt đối (spec 003, research R3/R4,
 * contracts/timing-engine.md): không giữ toàn bộ PCM trong RAM. Hai lượt đọc audio mỗi đơn vị:
 * lượt 1 cắt lặng để biết độ dài thật (đưa vào `placeUnits`), lượt 2 cắt lặng + nén + ghi.
 */

export type MergeTimedInput = {
  units: readonly ReadingUnit[];
  /** đơn vị bị nhà cung cấp từ chối nội dung: khe im lặng, không có audio (I9) */
  failed: ReadonlySet<number>;
  params: PlaceParams;
  /** đọc PCM chuẩn (24 kHz mono s16le) của đơn vị từ cache */
  readPcm: (idx: number) => Promise<Buffer>;
  pcmPath: string;
};

export type MergeTimedResult = {
  timeline: TimelineEntry[];
  totalSamples: number;
  durationMs: number;
  overflowCount: number;
  failedCount: number;
};

/** Chia mốc nội bộ từng cue trong đơn vị theo tỷ lệ số ký tự trên khoảng [startMs, endMs] đã đặt (chỉ để highlight). */
export function splitCueMarks(unit: ReadingUnit, startMs: number, endMs: number): TimelineCue[] | undefined {
  if (unit.split || unit.cues.length === 0) return undefined;
  const lens = unit.cues.map((c) => Math.max(1, [...c.text].length));
  const total = lens.reduce((a, b) => a + b, 0);
  const span = Math.max(0, endMs - startMs);
  let acc = 0;
  return unit.cues.map((c, i) => {
    const s = startMs + Math.round((span * acc) / total);
    acc += lens[i]!;
    const e = i === unit.cues.length - 1 ? endMs : startMs + Math.round((span * acc) / total);
    return { n: c.n, text: c.text, startMs: s, endMs: e };
  });
}

export async function mergeTimed(input: MergeTimedInput): Promise<MergeTimedResult> {
  const { units, failed, params } = input;

  // Lượt 1: độ dài thật (sau khi cắt lặng) của từng đơn vị có audio
  const audio: Array<{ idx: number; samples: number }> = [];
  for (const u of units) {
    if (failed.has(u.idx)) continue;
    const pcm = trimSilence(await input.readPcm(u.idx));
    audio.push({ idx: u.idx, samples: Math.floor(pcm.length / BYTES_PER_SAMPLE) });
  }
  const placement = placeUnits(units, audio, params);
  const byIdx = new Map(placement.placed.map((p) => [p.idx, p]));

  // Lượt 2: ghi tuần tự theo mốc tuyệt đối
  const timeline: TimelineEntry[] = [];
  let written = 0;
  let overflowCount = 0;
  const fh = await open(input.pcmPath, 'w');
  const writeSilence = async (samples: number) => {
    let left = samples;
    while (left > 0) {
      const n = Math.min(left, 48_000);
      await fh.write(Buffer.alloc(n * BYTES_PER_SAMPLE));
      left -= n;
    }
    written += Math.max(0, samples);
  };
  try {
    for (const u of units) {
      if (failed.has(u.idx)) {
        timeline.push({ idx: u.idx, startMs: u.startMs, endMs: u.slotEndMs, text: u.text, failed: true });
        continue;
      }
      const p = byIdx.get(u.idx)!;
      if (p.startSample > written) await writeSilence(p.startSample - written);

      let pcm = trimSilence(await input.readPcm(u.idx));
      if (p.compress > 1) pcm = await tempoPcm(pcm, p.compress);
      let samples = Math.floor(pcm.length / BYTES_PER_SAMPLE);
      if (samples > p.outSamples) samples = p.outSamples; // phần dư vài mẫu do làm tròn của bộ lọc: bỏ để không lệch mốc
      const startAt = written;
      await fh.write(pcm.subarray(0, samples * BYTES_PER_SAMPLE));
      written += samples;

      const startMs = samplesToMs(startAt);
      const endMs = samplesToMs(written);
      if (p.overflow) overflowCount += 1;
      timeline.push({
        idx: u.idx,
        startMs,
        endMs,
        text: u.text,
        slipMs: p.slipMs,
        compress: Number(p.compress.toFixed(4)),
        overflow: p.overflow,
        cues: splitCueMarks(u, startMs, endMs),
      });
    }
    // Voice dài tối thiểu bằng mốc kết thúc của cue cuối
    const lastSlot = units.length > 0 ? msToSamples(units[units.length - 1]!.slotEndMs) : 0;
    if (lastSlot > written) await writeSilence(lastSlot - written);
  } finally {
    await fh.close();
  }
  return { timeline, totalSamples: written, durationMs: samplesToMs(written), overflowCount, failedCount: failed.size };
}
