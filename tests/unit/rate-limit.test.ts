import { describe, expect, it } from 'vitest';
import { RateLimiter, getLimiter, requestsPerMinute } from '@/lib/providers/rate-limit';
import { SETTING_DEFAULTS, type Settings } from '@/lib/settings-defaults';

/** Đồng hồ giả: `sleep` đẩy thời gian tiến lên, không chờ thật. */
function fakeClock() {
  let t = 1_000_000;
  const slept: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number, signal?: AbortSignal) => {
      if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      slept.push(ms);
      t += ms;
    },
    advance: (ms: number) => (t += ms),
    slept,
  };
}

describe('RateLimiter (cửa sổ trượt 60 giây)', () => {
  it('cho đi ngay perMinute yêu cầu đầu rồi bắt chờ', async () => {
    const c = fakeClock();
    const rl = new RateLimiter(3, c);
    await rl.acquire();
    await rl.acquire();
    await rl.acquire();
    expect(c.slept).toEqual([]);
    await rl.acquire(); // yêu cầu thứ 4 phải chờ cho tới khi yêu cầu đầu rời cửa sổ
    expect(c.slept).toEqual([60_000]);
  });

  it('không bao giờ vượt perMinute trong bất kỳ cửa sổ 60 giây nào (nhiều yêu cầu song song)', async () => {
    const c = fakeClock();
    const perMinute = 30;
    const rl = new RateLimiter(perMinute, c);
    const stamps: number[] = [];
    await Promise.all(
      Array.from({ length: 100 }, async () => {
        await rl.acquire();
        stamps.push(c.now());
      }),
    );
    stamps.sort((a, b) => a - b);
    for (let i = 0; i + perMinute < stamps.length; i++) {
      expect(stamps[i + perMinute]! - stamps[i]!).toBeGreaterThanOrEqual(60_000);
    }
    expect(stamps).toHaveLength(100);
  });

  it('yêu cầu cách nhau đủ xa thì không phải chờ', async () => {
    const c = fakeClock();
    const rl = new RateLimiter(2, c);
    await rl.acquire();
    c.advance(31_000);
    await rl.acquire();
    c.advance(31_000); // yêu cầu đầu đã rời cửa sổ
    await rl.acquire();
    expect(c.slept).toEqual([]);
  });

  it('bị hủy khi đang chờ → ném AbortError (không treo)', async () => {
    const c = fakeClock();
    const rl = new RateLimiter(1, c);
    await rl.acquire();
    const ac = new AbortController();
    ac.abort();
    await expect(rl.acquire(ac.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('getLimiter / requestsPerMinute', () => {
  it('perMinute ≤ 0 hoặc không hữu hạn → không giới hạn (null)', () => {
    expect(getLimiter('cfg-a', 0)).toBeNull();
    expect(getLimiter('cfg-a', Number.NaN)).toBeNull();
  });

  it('cùng cấu hình AI dùng chung một bộ giới hạn; đổi giá trị thì tạo bộ mới', () => {
    const a = getLimiter('cfg-b', 30)!;
    expect(getLimiter('cfg-b', 30)).toBe(a);
    const b = getLimiter('cfg-b', 20)!;
    expect(b).not.toBe(a);
    expect(b.perMinute).toBe(20);
    expect(getLimiter('cfg-c', 30)).not.toBe(a);
  });

  it('cài đặt hệ thống rpm* > 0 ghi đè catalog; 0 dùng mặc định của catalog; nhà cung cấp không có mặc định → 0', () => {
    const base = { ...SETTING_DEFAULTS } as Settings;
    expect(requestsPerMinute('fpt_marketplace', base)).toBe(30); // mặc định theo tài liệu FPT
    expect(requestsPerMinute('fpt_marketplace', { ...base, rpmFptMarketplace: 12 })).toBe(12);
    expect(requestsPerMinute('shopaikey_minimax', base)).toBe(0);
    expect(requestsPerMinute('shopaikey_minimax', { ...base, rpmShopaikeyMinimax: 50 })).toBe(50);
  });
});
