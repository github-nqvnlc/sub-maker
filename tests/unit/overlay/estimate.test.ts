import { describe, expect, it } from 'vitest';
import type { OverlayConfig } from '@/lib/overlay/config';
import { estimateBytes } from '@/lib/overlay/estimate';
import { config } from './helpers';

const MB = 1024 * 1024;
const at = (over: Partial<OverlayConfig> = {}, ms = 60_000) => estimateBytes(config(over), ms);
const shadow = { enabled: true, color: '#000000', blur: 24 };
const box = { enabled: true, color: '#1E40FF', radius: 24, opacity: 50 };
const font = (size: number) => ({ ...config().font, size });

describe('estimateBytes (FR-034)', () => {
  it('theo định dạng (MB mỗi phút, kèm tiếng)', () => {
    expect(at() / MB).toBeCloseTo(4.5, 1);
    expect(at({ format: 'webm' }) / MB).toBeCloseTo(6.5, 1);
    expect(at({ format: 'mov' }) / MB).toBeCloseTo(211.4, 0);
  });

  it('không kèm tiếng thì nhỏ hơn; khung vuông nhỏ hơn; 16:9 bằng 9:16', () => {
    expect(at({ includeAudio: false })).toBeLessThan(at());
    expect(at({ aspect: '1:1' })).toBeLessThan(at());
    expect(at({ aspect: '16:9' })).toBe(at());
  });

  it('tăng theo thời lượng, là số nguyên byte dương', () => {
    expect(at({}, 120_000)).toBeGreaterThan(at({}, 60_000));
    for (const ms of [0, 1, 999, 10_000, 3_600_000]) {
      expect(Number.isInteger(at({}, ms))).toBe(true);
      expect(at({}, ms)).toBeGreaterThan(0);
    }
  });

  // Số đo thật của bộ dựng hình (2026-11-25, chữ phủ gần hết 10 giây, quy ra MB mỗi phút): ước tính không được thấp hơn và không quá gấp rưỡi
  it.each([
    ['mặc định', {}, 167],
    ['bóng mờ', { shadow }, 289.4],
    ['hộp 50%', { box }, 289.4],
    ['bóng mờ và hộp', { shadow, box }, 367.2],
    ['cỡ 120', { font: font(120) }, 267.8],
    ['bóng mờ, hộp, cỡ 120', { shadow, box, font: font(120) }, 642.3],
    ['khung vuông', { aspect: '1:1' }, 142.4],
  ] as Array<[string, Partial<OverlayConfig>, number]>)('.mov %s: sát số đo', (_n, over, measured) => {
    const est = at({ ...over, format: 'mov', background: 'transparent', includeAudio: false }) / MB;
    expect(est).toBeGreaterThanOrEqual(measured * 0.99);
    expect(est).toBeLessThanOrEqual(measured * 1.5);
  });

  it('bóng không mờ, hộp trong suốt hẳn và hiệu ứng rung chỉ ảnh hưởng đúng chỗ', () => {
    const mov = (over: Partial<OverlayConfig>) => at({ format: 'mov', background: 'transparent', ...over });
    expect(mov({ shadow: { ...shadow, blur: 0 } })).toBe(mov({}));
    expect(mov({ box: { ...box, opacity: 0 } })).toBe(mov({}));
    expect(mov({ font: font(24) })).toBeLessThan(mov({}));
    expect(at({ shadow, box })).toBe(at());
    // đo được 7,4 MB mỗi phút khi rung mọi câu
    expect(at({ enter: 'shake', shakeScope: 'all', includeAudio: false }) / MB).toBeGreaterThanOrEqual(7.4);
    expect(at({ enter: 'shake', shakeScope: 'exclaim' })).toBe(at());
  });
});
