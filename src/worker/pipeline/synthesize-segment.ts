import { and, eq } from 'drizzle-orm';
import { getDb } from '../../lib/db';
import { jobSegments } from '../../lib/db/schema';
import { decodeToPcm } from '../../lib/audio/ffmpeg';
import { sleep } from '../../lib/providers/adapters/shared';
import {
  ERROR_CODE,
  PROVIDER_ERROR_MESSAGE,
  ProviderError,
  isAbort,
  toProviderError,
  type ProviderErrorKind,
} from '../../lib/providers/errors';
import type { CallContext, TtsProvider } from '../../lib/providers/types';
import type { ProviderType } from '../../lib/schemas/common';
import { recordUsage } from '../../lib/usage/record';
import type { LogLevel } from '../job-log';
import { contentHash, loadCached, storeCached } from './cache';

/** Đoạn thất bại vĩnh viễn (hoặc hết lần thử). `kind` quyết định job dừng ngay hay chạy tiếp các đoạn khác. */
export class SegmentFailure extends Error {
  constructor(
    public readonly kind: ProviderErrorKind,
    public readonly idx: number,
  ) {
    super(PROVIDER_ERROR_MESSAGE[kind]);
    this.name = 'SegmentFailure';
  }
  get code(): string {
    return ERROR_CODE[this.kind];
  }
}

export type RetryPolicy = { maxAttempts: number; baseMs: number; maxMs: number };
export const DEFAULT_RETRY: RetryPolicy = { maxAttempts: 4, baseMs: 1000, maxMs: 15_000 };

export type SynthContext = {
  jobId: string;
  ownerId: string;
  projectId: string;
  providerType: ProviderType;
  configScope: 'global' | 'user';
  provider: TtsProvider;
  /** Dựng ngữ cảnh gọi (giải mã khóa, safeFetch) cho một lần gọi. */
  callContext: (signal: AbortSignal) => CallContext;
  settings: { model: string | null; voice: string; speed: number | null };
  pricePerMillionChars: number | null;
  signal: AbortSignal;
  /** Giới hạn yêu cầu/phút của cấu hình AI (spec 003); chờ lượt trước mỗi lần gọi nhà cung cấp, không chờ khi trúng cache. */
  limiter?: { acquire(signal?: AbortSignal): Promise<void> } | null;
  retry: RetryPolicy;
  log: (level: LogLevel, code: string, message: string, meta?: Record<string, unknown>) => Promise<void>;
};

export type SegmentResult = { audioCacheId: string; pcm: Buffer; durationMs: number; cacheHit: boolean };

async function setSegment(jobId: string, idx: number, patch: Partial<typeof jobSegments.$inferInsert>) {
  await getDb()
    .update(jobSegments)
    .set(patch)
    .where(and(eq(jobSegments.jobId, jobId), eq(jobSegments.idx, idx)));
}

/** Thời gian chờ trước lần thử kế tiếp: mũ + jitter, tôn trọng Retry-After của nhà cung cấp. */
export function backoffMs(attempt: number, policy: RetryPolicy, retryAfterMs?: number): number {
  const exp = policy.baseMs * 2 ** (attempt - 1) * (0.5 + Math.random());
  return Math.min(policy.maxMs, Math.max(retryAfterMs ?? 0, Math.round(exp)));
}

/**
 * Tạo audio cho MỘT đoạn: dùng cache nếu có (không gọi, không ghi usage); nếu không thì gọi nhà cung cấp
 * với thử lại có giới hạn cho lỗi tạm thời, KHÔNG thử lại lỗi vĩnh viễn (contracts/tts-provider.md).
 */
export async function synthesizeSegment(c: SynthContext, idx: number, text: string): Promise<SegmentResult> {
  const keyInput = {
    userId: c.ownerId,
    providerType: c.providerType,
    model: c.settings.model,
    voice: c.settings.voice,
    speed: c.settings.speed,
    text,
  };
  const hash = contentHash(keyInput);
  const chars = [...text].length;

  const cached = await loadCached(c.ownerId, hash);
  if (cached) {
    await setSegment(c.jobId, idx, { status: 'done', cacheHit: true, audioCacheId: cached.id, durationMs: cached.durationMs, errorCode: null });
    await c.log('info', 'SEGMENT_CACHE_HIT', `Đoạn ${idx + 1}: dùng lại audio đã có (không tốn phí)`, { idx, chars });
    return { audioCacheId: cached.id, pcm: cached.pcm, durationMs: cached.durationMs, cacheHit: true };
  }

  for (let attempt = 1; attempt <= c.retry.maxAttempts; attempt++) {
    if (c.signal.aborted) throw abortError();
    if (c.limiter) {
      try {
        await c.limiter.acquire(c.signal);
      } catch (e) {
        if (isAbort(e, c.signal)) throw abortError();
        throw e;
      }
    }
    await setSegment(c.jobId, idx, { status: 'running', attempts: attempt, errorCode: null });
    await c.log('info', 'SEGMENT_REQUEST', `Đoạn ${idx + 1}: gửi ${chars} ký tự tới nhà cung cấp${attempt > 1 ? ` (lần ${attempt})` : ''}`, { idx, chars, attempt });

    try {
      const res = await c.provider.synthesize(
        { text, model: c.settings.model, voice: c.settings.voice, speed: c.settings.speed },
        c.callContext(c.signal),
      );
      // Giải mã về PCM chuẩn; audio hỏng được coi là lỗi tạm thời của nhà cung cấp
      let pcm: Buffer;
      try {
        pcm = await decodeToPcm(res.audio);
      } catch {
        throw new ProviderError('transient');
      }
      await recordUsage({
        userId: c.ownerId,
        projectId: c.projectId,
        jobId: c.jobId,
        providerType: c.providerType,
        configScope: c.configScope,
        model: c.settings.model,
        voice: c.settings.voice,
        unitsChars: res.unitsChars,
        unitsTokens: res.unitsTokens ?? null,
        pricePerMillionChars: c.pricePerMillionChars,
        ok: true,
      });
      const stored = await storeCached({ ...keyInput, chars }, hash, pcm);
      await setSegment(c.jobId, idx, { status: 'done', cacheHit: false, audioCacheId: stored.id, durationMs: stored.durationMs, errorCode: null });
      await c.log('info', 'SEGMENT_DONE', `Đoạn ${idx + 1}: hoàn tất (${(stored.durationMs / 1000).toFixed(1)} giây)`, { idx, chars, durationMs: stored.durationMs });
      return { audioCacheId: stored.id, pcm: stored.pcm, durationMs: stored.durationMs, cacheHit: false };
    } catch (e) {
      if (isAbort(e, c.signal)) {
        await setSegment(c.jobId, idx, { status: 'pending' }).catch(() => undefined);
        throw abortError();
      }
      const pe = toProviderError(e);
      await recordUsage({
        userId: c.ownerId,
        projectId: c.projectId,
        jobId: c.jobId,
        providerType: c.providerType,
        configScope: c.configScope,
        model: c.settings.model,
        voice: c.settings.voice,
        unitsChars: chars,
        pricePerMillionChars: c.pricePerMillionChars,
        ok: false,
      }).catch(() => undefined);

      if (pe.retryable && attempt < c.retry.maxAttempts) {
        const wait = backoffMs(attempt, c.retry, pe.retryAfterMs);
        await c.log('warn', 'RETRY', `Đoạn ${idx + 1}: ${PROVIDER_ERROR_MESSAGE.transient} Thử lại sau ${(wait / 1000).toFixed(1)} giây`, { idx, attempt, waitMs: wait });
        await sleep(wait, c.signal).catch(() => {
          throw abortError();
        });
        continue;
      }
      await setSegment(c.jobId, idx, { status: 'failed', errorCode: pe.code });
      await c.log('error', 'SEGMENT_FAILED', `Đoạn ${idx + 1}: ${pe.message}`, { idx, code: pe.code, attempts: attempt });
      throw new SegmentFailure(pe.kind, idx);
    }
  }
  // Không tới được đây (vòng lặp luôn return/throw), giữ để TypeScript yên tâm
  throw new SegmentFailure('transient', idx);
}

export function abortError(): Error {
  const e = new Error('aborted');
  e.name = 'AbortError';
  return e;
}
