import { describe, expect, it } from 'vitest';
import { findActiveIndex, segmentStartSeconds, type TimelineSeg } from '@/lib/player/active-segment';

// 3 đoạn: [0,1000], [1380,1880], [2100,4100] (giữa các đoạn có khoảng lặng)
const T: TimelineSeg[] = [
  { idx: 0, startMs: 0, endMs: 1000 },
  { idx: 1, startMs: 1380, endMs: 1880 },
  { idx: 2, startMs: 2100, endMs: 4100 },
];

describe('findActiveIndex (FR-027)', () => {
  it('thời điểm nằm trong đoạn → đúng đoạn đó', () => {
    expect(findActiveIndex(T, 0)).toBe(0);
    expect(findActiveIndex(T, 500)).toBe(0);
    expect(findActiveIndex(T, 1500)).toBe(1);
    expect(findActiveIndex(T, 3000)).toBe(2);
  });

  it('biên: đúng thời điểm bắt đầu thuộc đoạn mới; ngay trước đó vẫn là đoạn cũ', () => {
    expect(findActiveIndex(T, 1380)).toBe(1);
    expect(findActiveIndex(T, 1379)).toBe(0);
    expect(findActiveIndex(T, 2100)).toBe(2);
    expect(findActiveIndex(T, 2099)).toBe(1);
  });

  it('trong khoảng lặng giữa hai đoạn giữ đoạn vừa đọc xong (không nháy tắt)', () => {
    expect(findActiveIndex(T, 1000)).toBe(0);
    expect(findActiveIndex(T, 1200)).toBe(0);
    expect(findActiveIndex(T, 1900)).toBe(1);
    expect(findActiveIndex(T, 2050)).toBe(1);
  });

  it('trước đoạn đầu → đoạn đầu; sau đoạn cuối → đoạn cuối; timeline rỗng → -1', () => {
    expect(findActiveIndex(T, -50)).toBe(0);
    expect(findActiveIndex(T, 4100)).toBe(2);
    expect(findActiveIndex(T, 999_999)).toBe(2);
    expect(findActiveIndex([], 100)).toBe(-1);
  });

  it('một đoạn duy nhất', () => {
    expect(findActiveIndex([{ idx: 7, startMs: 0, endMs: 500 }], 9999)).toBe(0);
  });

  it('tua lùi/tiến bất kỳ vẫn đúng (không phụ thuộc trạng thái trước)', () => {
    const seq = [3000, 100, 1500, 4000, 0, 2100];
    expect(seq.map((t) => findActiveIndex(T, t))).toEqual([2, 0, 1, 2, 0, 2]);
  });

  it('đúng với timeline lớn (hàng nghìn đoạn) và nhanh (tìm nhị phân)', () => {
    const big: TimelineSeg[] = Array.from({ length: 20_000 }, (_, i) => ({ idx: i, startMs: i * 1000, endMs: i * 1000 + 900 }));
    expect(findActiveIndex(big, 12_345_678)).toBe(12_345);
    const t0 = performance.now();
    for (let i = 0; i < 100_000; i++) findActiveIndex(big, (i * 7919) % 20_000_000);
    expect(performance.now() - t0).toBeLessThan(500);
  });

  it('segmentStartSeconds đổi ms sang giây để tua', () => {
    expect(segmentStartSeconds(T[1]!)).toBe(1.38);
  });
});
