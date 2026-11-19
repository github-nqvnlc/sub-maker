import { beforeAll, describe, expect, it } from 'vitest';
import { makeWav } from '../../mock-provider/server';
import { SAMPLE_RATE, decodeToPcm, encodeMp3, ffmpegAvailable, pcmDurationMs, pcmToWav, wavToPcm } from '@/lib/audio/ffmpeg';
import { mergePcm, pauseAfter } from '@/lib/audio/merge';

/** PCM im lặng có độ dài chính xác theo mili giây. */
const pcm = (ms: number) => Buffer.alloc(Math.round((ms * SAMPLE_RATE) / 1000) * 2);

let hasFfmpeg = false;
beforeAll(async () => {
  hasFfmpeg = await ffmpegAvailable();
});

describe('khoảng lặng theo dấu câu (FR-016, research R7)', () => {
  it('~380 ms sau . ! ? …, ~220 ms sau , ; :, còn lại 300 ms', () => {
    for (const t of ['Xong rồi.', 'Thật vậy!', 'Thế à?', 'Còn nữa…']) expect(pauseAfter(t), t).toBe(380);
    for (const t of ['Thứ nhất,', 'Tiếp theo;', 'Như sau:']) expect(pauseAfter(t), t).toBe(220);
    for (const t of ['Tiêu đề không dấu', 'Số 123']) expect(pauseAfter(t), t).toBe(300);
  });

  it('bỏ qua ngoặc/nháy đóng ở cuối', () => {
    expect(pauseAfter('Anh ấy nói "đi thôi."')).toBe(380);
    expect(pauseAfter('(xem hình bên)')).toBe(300);
    expect(pauseAfter('Kết thúc.”')).toBe(380);
  });
});

describe('ghép PCM và tính timeline theo số mẫu', () => {
  const parts = [
    { idx: 0, pcm: pcm(1000), text: 'Câu thứ nhất.' }, // +380
    { idx: 1, pcm: pcm(500), text: 'Câu thứ hai,' }, // +220
    { idx: 2, pcm: pcm(2000), text: 'Câu cuối cùng.' }, // không có khoảng lặng cuối
  ];

  it('mốc bắt đầu/kết thúc chính xác từng mili giây', () => {
    const r = mergePcm(parts);
    expect(r.timeline).toEqual([
      { idx: 0, startMs: 0, endMs: 1000 },
      { idx: 1, startMs: 1380, endMs: 1880 },
      { idx: 2, startMs: 2100, endMs: 4100 },
    ]);
  });

  it('tổng thời lượng = tổng đoạn + khoảng lặng giữa các đoạn (không có khoảng lặng sau đoạn cuối)', () => {
    const r = mergePcm(parts);
    expect(r.durationMs).toBe(1000 + 380 + 500 + 220 + 2000);
    expect(pcmDurationMs(r.pcm)).toBe(r.durationMs);
    expect(r.pcm.length % 2).toBe(0);
  });

  it('khoảng lặng giữa các đoạn thực sự là im lặng (toàn số 0)', () => {
    const loud = (ms: number) => {
      const b = Buffer.alloc(Math.round((ms * SAMPLE_RATE) / 1000) * 2);
      for (let i = 0; i < b.length; i += 2) b.writeInt16LE(1000, i);
      return b;
    };
    const r = mergePcm([
      { idx: 0, pcm: loud(100), text: 'A.' },
      { idx: 1, pcm: loud(100), text: 'B.' },
    ]);
    const gapStart = Math.round((100 * SAMPLE_RATE) / 1000) * 2;
    const gapEnd = gapStart + Math.round((380 * SAMPLE_RATE) / 1000) * 2;
    expect(r.pcm.subarray(gapStart, gapEnd).every((b) => b === 0)).toBe(true);
    expect(r.pcm.readInt16LE(gapStart - 2)).toBe(1000);
    expect(r.pcm.readInt16LE(gapEnd)).toBe(1000);
  });

  it('một đoạn duy nhất: không có khoảng lặng; không có đoạn: rỗng', () => {
    expect(mergePcm([{ idx: 0, pcm: pcm(700), text: 'Một.' }]).durationMs).toBe(700);
    expect(mergePcm([])).toMatchObject({ durationMs: 0, timeline: [] });
  });

  it('sai số tích lũy không vượt quá 1 ms dù có hàng trăm đoạn (làm tròn theo mẫu, không cộng dồn ms)', () => {
    const many = Array.from({ length: 500 }, (_, i) => ({ idx: i, pcm: pcm(333), text: i % 2 ? 'Có dấu chấm.' : 'Có dấu phẩy,' }));
    const r = mergePcm(many);
    // 500 đoạn → 499 khoảng lặng: sau đoạn chẵn (dấu phẩy) 250 lần, sau đoạn lẻ (dấu chấm) 249 lần (đoạn cuối không có)
    const exact = many.reduce((s, p) => s + p.pcm.length / 2, 0) + 249 * Math.round((380 * SAMPLE_RATE) / 1000) + 250 * Math.round((220 * SAMPLE_RATE) / 1000);
    expect(Math.abs(r.durationMs - (exact * 1000) / SAMPLE_RATE)).toBeLessThanOrEqual(1);
    // timeline đơn điệu và không chồng lấn
    for (let i = 1; i < r.timeline.length; i++) {
      expect(r.timeline[i]!.startMs).toBeGreaterThanOrEqual(r.timeline[i - 1]!.endMs);
    }
  });

  it('PCM có độ dài lẻ bị từ chối', () => {
    expect(() => mergePcm([{ idx: 0, pcm: Buffer.alloc(3), text: 'x.' }])).toThrow(/lẻ/);
  });

  it('tuỳ chỉnh khoảng lặng', () => {
    const r = mergePcm(parts.slice(0, 2), { sentence: 1000, comma: 0, other: 0 });
    expect(r.timeline[1]!.startMs).toBe(2000);
  });
});

describe('WAV bao quanh PCM (cache)', () => {
  it('pcmToWav rồi wavToPcm trả đúng dữ liệu', () => {
    const data = Buffer.from(Array.from({ length: 400 }, (_, i) => i % 251));
    expect(wavToPcm(pcmToWav(data)).equals(data)).toBe(true);
  });
  it('tệp không phải WAV bị từ chối', () => {
    expect(() => wavToPcm(Buffer.from('không phải wav, đủ dài để qua kiểm tra độ dài tối thiểu 44 byte...'))).toThrow();
  });
});

describe('ffmpeg: giải mã về PCM chuẩn và mã hóa MP3', () => {
  it('giải mã WAV 16 kHz về 24 kHz mono: thời lượng giữ nguyên (±5 ms)', async (ctx) => {
    if (!hasFfmpeg) return ctx.skip();
    const out = await decodeToPcm(makeWav(1000, 16_000));
    expect(Math.abs(pcmDurationMs(out) - 1000)).toBeLessThanOrEqual(5);
  });

  it('giải mã WAV 24 kHz: số mẫu chính xác', async (ctx) => {
    if (!hasFfmpeg) return ctx.skip();
    const out = await decodeToPcm(makeWav(1500, 24_000));
    expect(out.length / 2).toBe(36_000);
  });

  it('mp3 cuối lệch ≤ 50 ms so với PCM gốc (độ trễ bộ mã hóa), giải mã ngược được', async (ctx) => {
    if (!hasFfmpeg) return ctx.skip();
    const merged = mergePcm([
      { idx: 0, pcm: await decodeToPcm(makeWav(800)), text: 'Một.' },
      { idx: 1, pcm: await decodeToPcm(makeWav(1200)), text: 'Hai.' },
    ]);
    const mp3 = await encodeMp3(merged.pcm);
    expect(mp3.length).toBeGreaterThan(1000);
    expect(mp3.subarray(0, 3).toString('latin1') === 'ID3' || (mp3[0] === 0xff && (mp3[1]! & 0xe0) === 0xe0)).toBe(true);
    const back = await decodeToPcm(mp3);
    expect(Math.abs(pcmDurationMs(back) - merged.durationMs)).toBeLessThanOrEqual(50);
  });

  it('dữ liệu không phải audio → lỗi rõ ràng (không treo)', async (ctx) => {
    if (!hasFfmpeg) return ctx.skip();
    await expect(decodeToPcm(Buffer.from('đây không phải audio'))).rejects.toThrow(/ffmpeg/);
  });
});
