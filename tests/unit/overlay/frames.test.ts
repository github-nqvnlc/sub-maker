import { describe, expect, it } from 'vitest';
import { FPS, FRAME_MS, frameCount, framesToMs, frameTimeMs } from '@/lib/overlay/frames';

/** Căn khung với thời gian (research R6; SC-002, SC-003): không trôi ở phút 60, không cần xuất video dài. */
describe('phép tính khung', () => {
  it('30 hình/giây, thời điểm giữa khung', () => {
    expect(FPS).toBe(30);
    expect(frameTimeMs(0)).toBeCloseTo(16.667, 2);
    expect(frameTimeMs(29)).toBeCloseTo(983.333, 2);
    expect(FRAME_MS).toBeGreaterThanOrEqual(1000 / FPS);
  });

  it('thời lượng video lệch voice không quá 16,7 ms ở mọi thời lượng tới 60 phút', () => {
    for (const ms of [1, 20, 33, 1000, 9_999, 10_016, 10_017, 61_234, 600_001, 3_599_983, 3_600_000]) {
      const diff = Math.abs(framesToMs(frameCount(ms)) - ms);
      if (ms >= 17) expect(diff).toBeLessThanOrEqual(16.7);
      expect(frameCount(ms)).toBeGreaterThanOrEqual(1);
    }
  });

  it('mốc hiện/ẩn lệch không quá 16,7 ms, kể cả ở phút 60 (không cộng dồn)', () => {
    for (const mark of [0, 333, 5_200, 7_800, 59_999, 3_599_100, 3_599_817]) {
      // khung đầu tiên có thời điểm đại diện ≥ mốc
      const k = Math.max(0, Math.ceil((mark * FPS) / 1000 - 0.5));
      expect(frameTimeMs(k)).toBeGreaterThanOrEqual(mark);
      if (k > 0) expect(frameTimeMs(k - 1)).toBeLessThan(mark);
      // người xem thấy khung k từ k/30 giây
      expect(Math.abs(framesToMs(k) - mark)).toBeLessThanOrEqual(16.7);
    }
  });
});
