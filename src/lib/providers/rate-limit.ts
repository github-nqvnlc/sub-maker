import type { ProviderType } from '../schemas/common';
import type { Settings } from '../settings';
import { getCatalog } from './catalog';

/**
 * Giới hạn số yêu cầu mỗi phút tới nhà cung cấp (spec 003, research R5). Cửa sổ trượt 60 giây (nghiêm ngặt):
 * không bao giờ phát quá `perMinute` yêu cầu trong bất kỳ 60 giây liên tiếp nào; vượt thì CHỜ chứ không lỗi.
 * Giá trị mặc định lấy từ catalog (ước tính theo tài liệu nhà cung cấp) và Administrator ghi đè bằng cài đặt hệ thống
 * `rpm*` (0 = dùng mặc định) — không hard-code như sự thật cố định (Nguyên tắc IV).
 */

const WINDOW_MS = 60_000;

export type LimiterDeps = {
  now?: () => number;
  /** Chờ `ms`; phải reject khi `signal` bị hủy. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

const realSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

export class RateLimiter {
  private readonly stamps: number[] = [];
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Hàng đợi tuần tự để các lần `acquire` song song không cùng thấy còn chỗ. */
  private tail: Promise<void> = Promise.resolve();

  constructor(
    readonly perMinute: number,
    deps: LimiterDeps = {},
  ) {
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? realSleep;
  }

  acquire(signal?: AbortSignal): Promise<void> {
    const run = this.tail.then(() => this.take(signal));
    this.tail = run.catch(() => undefined);
    return run;
  }

  private async take(signal?: AbortSignal): Promise<void> {
    for (;;) {
      const t = this.now();
      while (this.stamps.length > 0 && t - this.stamps[0]! >= WINDOW_MS) this.stamps.shift();
      if (this.stamps.length < this.perMinute) {
        this.stamps.push(t);
        return;
      }
      await this.sleep(Math.max(1, WINDOW_MS - (t - this.stamps[0]!)), signal);
    }
  }
}

const registry = new Map<string, RateLimiter>();

/** Một bộ giới hạn dùng chung cho mọi tiến trình dùng cùng một cấu hình AI (cùng khóa nhà cung cấp) trong một worker. */
export function getLimiter(configId: string, perMinute: number): RateLimiter | null {
  if (!Number.isFinite(perMinute) || perMinute <= 0) return null;
  const cur = registry.get(configId);
  if (cur && cur.perMinute === perMinute) return cur;
  const next = new RateLimiter(perMinute);
  registry.set(configId, next);
  return next;
}

const OVERRIDE_KEY: Partial<Record<ProviderType, keyof Settings>> = {
  fpt_marketplace: 'rpmFptMarketplace',
  shopaikey_openai: 'rpmShopaikeyOpenai',
  shopaikey_minimax: 'rpmShopaikeyMinimax',
};

/** Số yêu cầu/phút áp dụng: cài đặt hệ thống (nếu > 0) thay mặc định của catalog; 0 = không giới hạn. */
export function requestsPerMinute(type: ProviderType, settings: Settings): number {
  const key = OVERRIDE_KEY[type];
  const override = key ? settings[key] : undefined;
  if (typeof override === 'number' && override > 0) return override;
  return getCatalog(type).requestsPerMinute ?? 0;
}
