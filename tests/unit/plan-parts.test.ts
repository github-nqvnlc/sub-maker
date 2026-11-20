import { describe, expect, it } from 'vitest';
import { planParts, type PartUnit } from '@/lib/audio/placement';

const MIN = 60_000;
/** Chuỗi đơn vị tổng hợp: mỗi đơn vị dài `dur` ms, cách nhau `gap(i)` ms (chỉ bằng số, không audio). */
function makeUnits(n: number, dur = 1500, gap: (i: number) => number = () => 300): PartUnit[] {
  const out: PartUnit[] = [];
  let t = 0;
  for (let i = 0; i < n; i++) {
    out.push({ idx: i, startMs: t, slotEndMs: t + dur });
    t += dur + gap(i);
  }
  return out;
}

describe('planParts', () => {
  it('phụ đề ngắn hơn một cửa sổ → một phần duy nhất', () => {
    const u = makeUnits(20);
    const p = planParts(u, 10 * MIN);
    expect(p).toEqual([{ n: 1, fromUnit: 0, toUnit: 19, startMs: 0, endMs: u[19]!.slotEndMs }]);
  });

  it('danh sách rỗng → không có phần', () => {
    expect(planParts([], 10 * MIN)).toEqual([]);
  });

  it('cắt tại khoảng nghỉ LỚN NHẤT trong ±20% quanh mỗi mốc k·cửa sổ', () => {
    // 3 phút, cửa sổ 1 phút; khoảng nghỉ 300 ms mặc định, có hai khoảng nghỉ lớn ở ~58 s và ~125 s
    const units = makeUnits(400, 400, () => 100);
    const bigAfter = new Map<number, number>();
    // tìm đơn vị đầu tiên bắt đầu ≥ 58 s và ≥ 125 s để đặt khoảng nghỉ lớn ngay sau đơn vị trước nó
    const find = (ms: number) => units.findIndex((x) => x.startMs >= ms);
    bigAfter.set(find(58_000) - 1, 4000);
    bigAfter.set(find(125_000) - 1, 3000);
    const u = makeUnits(400, 400, (i) => bigAfter.get(i) ?? 100);
    const parts = planParts(u, MIN);
    expect(parts.length).toBeGreaterThanOrEqual(3);
    const cutAfter = parts.slice(0, -1).map((p) => p.toUnit);
    expect(cutAfter).toContain(find(58_000) - 1);
    // sau điểm cắt thứ nhất, khoảng nghỉ lớn thứ hai (≈125 s) nằm trong dải của k=2 (96–144 s) và được chọn
    const second = u.findIndex((x, i) => i > 0 && u[i - 1]!.slotEndMs + 3000 === x.startMs);
    expect(second).toBeGreaterThan(0);
    expect(cutAfter).toContain(second - 1);
  });

  it('phủ mọi đơn vị đúng một lần, theo thứ tự, không đơn vị nào bị cắt đôi', () => {
    const u = makeUnits(1000, 1200, (i) => 80 + (i % 11) * 40);
    const parts = planParts(u, 2 * MIN);
    expect(parts[0]!.fromUnit).toBe(0);
    expect(parts[parts.length - 1]!.toUnit).toBe(u.length - 1);
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i]!;
      expect(p.n).toBe(i + 1);
      expect(p.toUnit).toBeGreaterThanOrEqual(p.fromUnit);
      if (i > 0) expect(p.fromUnit).toBe(parts[i - 1]!.toUnit + 1);
      expect(p.startMs).toBe(u[p.fromUnit]!.startMs);
      expect(p.endMs).toBe(u[p.toUnit]!.slotEndMs);
    }
  });

  it('không có khoảng nghỉ nào trong dải thì cắt tại ranh giới đơn vị gần mốc nhất', () => {
    // một đơn vị cực dài che cả dải quanh mốc 1 phút: không có ranh giới trong 48–72 s
    const u: PartUnit[] = [
      { idx: 0, startMs: 0, slotEndMs: 1000 },
      { idx: 1, startMs: 1500, slotEndMs: 100_000 }, // bao trùm dải
      { idx: 2, startMs: 100_500, slotEndMs: 101_000 },
      { idx: 3, startMs: 101_500, slotEndMs: 102_000 },
    ];
    const parts = planParts(u, MIN);
    expect(parts.length).toBeGreaterThanOrEqual(2);
    expect(parts[0]!.toUnit).toBeLessThan(3);
  });

  it('xác định: cùng đầu vào cho cùng kết quả', () => {
    const u = makeUnits(500, 900, (i) => 50 + ((i * 37) % 400));
    expect(planParts(u, MIN)).toEqual(planParts(u, MIN));
  });

  it('tập tổng hợp 3 giờ (≈ 3.000 đơn vị) chỉ bằng số chạy dưới 1 giây, phần ≈ 18 × 10 phút', () => {
    const u = makeUnits(7200, 1000, (i) => 200 + (i % 9) * 60); // ≈ 3 giờ
    const t0 = performance.now();
    const parts = planParts(u, 10 * MIN);
    expect(performance.now() - t0).toBeLessThan(1000);
    const hours = u[u.length - 1]!.slotEndMs / 3_600_000;
    expect(hours).toBeGreaterThan(2.5);
    expect(parts.length).toBeGreaterThanOrEqual(15);
    expect(parts.length).toBeLessThanOrEqual(20);
    // mỗi điểm cắt nằm gần một mốc k × 10 phút (trong ±20% cửa sổ = ±2 phút)
    parts.slice(1).forEach((p, i) => {
      const cutMs = p.startMs;
      const k = i + 1;
      expect(Math.abs(cutMs - k * 10 * MIN)).toBeLessThanOrEqual(2 * MIN + 2000);
    });
  });
});
