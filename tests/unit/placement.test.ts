import { describe, expect, it } from 'vitest';
import { DEFAULT_PLACE_PARAMS, msToSamples, placeUnits, samplesToMs, type PlaceUnit } from '@/lib/audio/placement';

const P = DEFAULT_PLACE_PARAMS; // slip 500 ms, nén 1,25, minGap 60 ms
const a = (idx: number, ms: number) => ({ idx, samples: msToSamples(ms) });
const u = (idx: number, startMs: number, slotEndMs: number): PlaceUnit => ({ idx, startMs, slotEndMs });

describe('placeUnits — trường hợp cơ bản', () => {
  it('đủ chỗ: đặt đúng mốc, không nén, không trượt (I2, I3, I8)', () => {
    const units = [u(0, 0, 1500), u(1, 2000, 3500), u(2, 4000, 5500)];
    const r = placeUnits(units, [a(0, 1200), a(1, 1200), a(2, 1200)], P);
    expect(r.placed.map((p) => samplesToMs(p.startSample))).toEqual([0, 2000, 4000]);
    expect(r.placed.every((p) => p.compress === 1 && p.slipMs === 0 && !p.overflow)).toBe(true);
    expect(samplesToMs(r.totalSamples)).toBe(5200);
  });

  it('I8: S_0 = 0 bắt đầu đúng tại 0; S_0 > 0 mở đầu bằng im lặng', () => {
    expect(samplesToMs(placeUnits([u(0, 0, 1000)], [a(0, 500)], P).placed[0]!.startSample)).toBe(0);
    expect(samplesToMs(placeUnits([u(0, 300, 1000)], [a(0, 500)], P).placed[0]!.startSample)).toBe(300);
  });

  it('mượn khoảng nghỉ liền sau mà không nén (I3)', () => {
    // khe 1000 ms nhưng cue kế bắt đầu sau 1500 ms; lời đọc 1300 ms vừa trong 1500 − 60
    const r = placeUnits([u(0, 0, 1000), u(1, 1500, 2500)], [a(0, 1300), a(1, 500)], P);
    expect(r.placed[0]).toMatchObject({ compress: 1, slipMs: 0 });
    expect(r.placed[1]!.slipMs).toBe(0);
  });

  it('nén nhẹ vừa khít khi tràn khe nhưng trong mức cho phép', () => {
    // khả dụng = 2000 − 60 = 1940; lời đọc 2300 → f ≈ 1,186 ≤ 1,25
    const r = placeUnits([u(0, 0, 2000), u(1, 2000, 3000)], [a(0, 2300), a(1, 500)], P);
    const p0 = r.placed[0]!;
    expect(p0.compress).toBeGreaterThan(1);
    expect(p0.compress).toBeLessThanOrEqual(P.maxCompress);
    expect(p0.outSamples).toBe(msToSamples(1940));
    expect(r.placed[1]!.slipMs).toBe(0);
    expect(r.placed[1]!.startSample).toBe(msToSamples(2000));
  });

  it('ví dụ "Không Putin.": khe hẹp, nén tối đa 1,25 và tràn thành độ trễ nhỏ cho đơn vị kế', () => {
    const r = placeUnits([u(0, 8772, 9772), u(1, 9853, 11000)], [a(0, 1280), a(1, 600)], P);
    const p0 = r.placed[0]!;
    expect(p0.compress).toBeCloseTo(1.25, 2);
    expect(p0.outSamples).toBe(Math.ceil(msToSamples(1280) / 1.25));
    const p1 = r.placed[1]!;
    expect(p1.slipMs).toBeLessThanOrEqual(P.maxSlipMs);
    expect(p1.overflow).toBe(false);
  });

  it('trượt nhẹ: tràn qua mốc kế thì đơn vị kế bắt đầu trễ rồi bù ở khoảng nghỉ sau (I4)', () => {
    // đơn vị 0 dài 3000 ms trong khe 1000 → nén 1,25 → 2400 ms; đơn vị 1 vốn bắt đầu 1100
    const units = [u(0, 0, 1000), u(1, 1100, 2000), u(2, 6000, 7000)];
    const r = placeUnits(units, [a(0, 3000), a(1, 800), a(2, 800)], P);
    expect(r.placed[0]!.compress).toBeCloseTo(1.25, 2);
    expect(r.placed[1]!.slipMs).toBe(1360); // 2400 + 60 − 1100
    expect(r.placed[1]!.overflow).toBe(true); // > 500 ms
    expect(r.placed[2]!.slipMs).toBe(0); // khoảng nghỉ lớn → bù hết
    expect(samplesToMs(r.placed[2]!.startSample)).toBe(6000);
  });

  it('overflow ⇔ slipMs > maxSlipMs, vẫn đặt đơn vị (I7)', () => {
    const r = placeUnits([u(0, 0, 1000), u(1, 1100, 2100)], [a(0, 1800), a(1, 500)], { ...P, maxSlipMs: 100 });
    const p1 = r.placed[1]!;
    expect(p1.slipMs).toBeGreaterThan(100);
    expect(p1.overflow).toBe(true);
    expect(p1.outSamples).toBe(msToSamples(500));
    const ok = placeUnits([u(0, 0, 1000), u(1, 1100, 2100)], [a(0, 1800), a(1, 500)], { ...P, maxSlipMs: 5000 });
    expect(ok.placed[1]!.overflow).toBe(false);
  });

  it('đơn vị cuối không có mốc kế: không bao giờ nén (khả dụng vô hạn)', () => {
    const r = placeUnits([u(0, 0, 500)], [a(0, 5000)], P);
    expect(r.placed[0]).toMatchObject({ compress: 1 });
    expect(r.placed[0]!.outSamples).toBe(msToSamples(5000));
  });

  it('I9: đơn vị không có audio (đoạn lỗi) bị bỏ qua, không gây trượt và nhường khe cho đơn vị trước', () => {
    const units = [u(0, 0, 1000), u(1, 1100, 2000), u(2, 4000, 5000)];
    const r = placeUnits(units, [a(0, 2500), a(2, 500)], P); // đơn vị 1 lỗi: không có audio
    expect(r.placed.map((p) => p.idx)).toEqual([0, 2]);
    expect(r.placed[0]!.compress).toBe(1); // mượn cả khe im lặng của đơn vị lỗi (khả dụng 3940 ms)
    expect(r.placed[1]!.slipMs).toBe(0);
  });
});

describe('placeUnits — bất biến trên dữ liệu ngẫu nhiên có hạt giống (I1, I2, I3, I5, I6)', () => {
  const rng = (seed: number) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);

  it('không chồng tiếng, không sớm hơn mốc, nén trong khoảng, xác định, không cắt lời', () => {
    const rand = rng(7);
    const units: PlaceUnit[] = [];
    const audio = [];
    let t = 0;
    for (let i = 0; i < 400; i++) {
      const slot = 600 + Math.floor(rand() * 2500);
      units.push(u(i, t, t + slot));
      audio.push(a(i, 400 + Math.floor(rand() * 3500)));
      t += slot + Math.floor(rand() * 600);
    }
    const r1 = placeUnits(units, audio, P);
    const r2 = placeUnits(units, audio, P);
    expect(r1).toEqual(r2); // I5
    for (let i = 0; i < r1.placed.length; i++) {
      const p = r1.placed[i]!;
      const S = msToSamples(units[p.idx]!.startMs);
      expect(p.startSample).toBeGreaterThanOrEqual(S); // I2
      expect(p.compress).toBeGreaterThanOrEqual(1);
      expect(p.compress).toBeLessThanOrEqual(P.maxCompress + 1e-9); // I3
      expect(p.outSamples).toBeGreaterThanOrEqual(Math.floor(p.inSamples / P.maxCompress)); // I6: không cắt lời
      if (i > 0) {
        const q = r1.placed[i - 1]!;
        expect(p.startSample).toBeGreaterThanOrEqual(q.startSample + q.outSamples); // I1
      }
    }
  });

  it('I10: 3.000 đơn vị tổng hợp (chỉ bằng số) — độ trễ ở cuối không lớn hơn ở đầu, không cộng dồn', () => {
    const units: PlaceUnit[] = [];
    const audio = [];
    for (let i = 0; i < 3000; i++) {
      units.push(u(i, i * 2000, i * 2000 + 1500));
      audio.push(a(i, i % 7 === 3 ? 3000 : 1500)); // cứ 7 đơn vị có một đơn vị đọc quá dài (tràn)
    }
    const r = placeUnits(units, audio, P);
    const maxHead = Math.max(...r.placed.slice(0, 100).map((p) => p.slipMs));
    const last = r.placed[r.placed.length - 1]!;
    expect(maxHead).toBeGreaterThan(0); // có trượt thật ở đầu
    expect(last.slipMs).toBeLessThanOrEqual(maxHead);
    expect(Math.max(...r.placed.map((p) => p.slipMs))).toBeLessThanOrEqual(P.maxSlipMs);
    // đơn vị cuối vẫn gần đúng mốc: không trôi tích lũy
    expect(Math.abs(samplesToMs(last.startSample) - units[2999]!.startMs)).toBeLessThanOrEqual(P.maxSlipMs);
  });
});
