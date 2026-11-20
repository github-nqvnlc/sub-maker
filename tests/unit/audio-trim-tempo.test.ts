import { beforeAll, describe, expect, it } from 'vitest';
import { BYTES_PER_SAMPLE, SAMPLE_RATE, ffmpegAvailable } from '@/lib/audio/ffmpeg';
import { tempoPcm } from '@/lib/audio/tempo';
import { trimSilence } from '@/lib/audio/trim';

const samplesOf = (ms: number) => Math.round((ms * SAMPLE_RATE) / 1000);

/** PCM: `leadMs` im lặng + `toneMs` âm sin biên độ 3000 + `tailMs` im lặng. */
function pcm(leadMs: number, toneMs: number, tailMs: number): Buffer {
  const lead = samplesOf(leadMs);
  const tone = samplesOf(toneMs);
  const tail = samplesOf(tailMs);
  const buf = Buffer.alloc((lead + tone + tail) * BYTES_PER_SAMPLE);
  for (let i = 0; i < tone; i++) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 220 * i) / SAMPLE_RATE) * 3000), (lead + i) * BYTES_PER_SAMPLE);
  return buf;
}
const ms = (b: Buffer) => (b.length / BYTES_PER_SAMPLE / SAMPLE_RATE) * 1000;

describe('trimSilence', () => {
  it('cắt lặng đầu/cuối, giữ lại 30 ms mỗi phía', () => {
    const out = trimSilence(pcm(300, 500, 400));
    expect(ms(out)).toBeGreaterThan(500 + 50);
    expect(ms(out)).toBeLessThan(500 + 70); // 500 + 2 × 30
  });

  it('không có khoảng lặng thì giữ nguyên', () => {
    const src = pcm(0, 500, 0);
    expect(ms(trimSilence(src))).toBeCloseTo(500, 0);
  });

  it('toàn im lặng → giữ tối thiểu một mẫu hợp lệ', () => {
    const out = trimSilence(pcm(500, 0, 0));
    expect(out.length).toBe(BYTES_PER_SAMPLE);
  });

  it('không đổi dữ liệu tiếng nói bên trong (cắt đúng đoạn)', () => {
    const src = pcm(200, 300, 200);
    const out = trimSilence(src, { keepMs: 0 });
    expect(ms(out)).toBeGreaterThan(299);
    expect(ms(out)).toBeLessThan(302);
  });
});

describe('tempoPcm (cần ffmpeg)', () => {
  let ok = false;
  beforeAll(async () => {
    ok = await ffmpegAvailable();
  });

  it('nén 1,25× cho độ dài ≈ n/1,25 (±3%)', async (ctx) => {
    if (!ok) return ctx.skip();
    const src = pcm(0, 2000, 0);
    const out = await tempoPcm(src, 1.25);
    expect(ms(out) / (2000 / 1.25)).toBeGreaterThan(0.97);
    expect(ms(out) / (2000 / 1.25)).toBeLessThan(1.03);
  });

  it('hệ số 1 trả nguyên buffer; ngoài khoảng 1–2 → lỗi', async () => {
    const src = pcm(0, 100, 0);
    expect(await tempoPcm(src, 1)).toBe(src);
    await expect(tempoPcm(src, 0.9)).rejects.toThrow();
    await expect(tempoPcm(src, 2.5)).rejects.toThrow();
  });
});
