import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { expectedDurationMs, startMockProvider, type MockProvider } from '../../mock-provider/server';
import { ProviderError } from '@/lib/providers/errors';
import { looksLikeAudio } from '@/lib/providers/adapters/shared';
import type { CallContext, SynthesizeRequest, TtsProvider } from '@/lib/providers/types';
import { createSafeFetch } from '@/lib/security/safe-fetch';

/**
 * Bộ kiểm thử HỢP ĐỒNG chung cho mọi adapter (contracts/tts-provider.md). Mỗi adapter có một file test
 * gọi `defineAdapterSuite` với fixture riêng; hành vi bắt buộc giống nhau, chỉ khác cách xác thực/giao thức.
 */
export type AdapterFixture = {
  name: string;
  provider: TtsProvider;
  /** Địa chỉ gốc để trỏ vào máy chủ giả với một kịch bản. */
  baseFor: (mockUrl: string, scenario: string) => string;
  request: SynthesizeRequest;
  supports: {
    forbiddenModel?: boolean;
    voiceInvalid?: boolean;
    internalLink?: boolean;
  };
  /** Kiểm tra kiểu xác thực của riêng adapter trên yêu cầu mock đã ghi nhận. */
  checkAuth: (headers: Record<string, string | string[] | undefined>, apiKey: string) => void;
};

const API_KEY = 'sk-contract-test-KEY-0123456789';
const FAST_POLL = { initialMs: 10, maxMs: 30, timeoutMs: 3000 } as const;

export function defineAdapterSuite(fx: AdapterFixture) {
  let mock: MockProvider;

  const ctxFor = (scenario: string, extra: Partial<CallContext> & { timeoutMs?: number } = {}): CallContext => ({
    config: { baseUrl: fx.baseFor(mock.url, scenario), apiKey: API_KEY },
    fetch: createSafeFetch({ allowInsecure: true, timeoutMs: extra.timeoutMs ?? 5000 }),
    polling: FAST_POLL,
    ...extra,
  });

  const expectKind = async (scenario: string, kind: string, req = fx.request) => {
    const err = await fx.provider.synthesize(req, ctxFor(scenario)).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err, `kịch bản ${scenario} phải ném lỗi`).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).kind).toBe(kind);
    return err as ProviderError;
  };

  beforeAll(async () => {
    mock = await startMockProvider();
  });
  afterAll(async () => {
    await mock.close();
  });
  beforeEach(() => mock.reset());

  describe(`adapter ${fx.name}`, () => {
    it('thành công: trả audio hợp lệ, đếm đúng số ký tự Unicode, không bịa token', async () => {
      const text = 'Xin chào, đây là bài kiểm thử tiếng Việt.';
      const res = await fx.provider.synthesize({ ...fx.request, text }, ctxFor('ok'));
      expect(looksLikeAudio(res.audio)).toBe(true);
      expect(res.unitsChars).toBe([...text].length);
      expect(res.unitsTokens).toBeUndefined();
      // WAV của mock có độ dài tỉ lệ số ký tự → chứng tỏ nội dung đã được gửi đúng
      if (res.mime === 'audio/wav') {
        const dataBytes = Buffer.from(res.audio).readUInt32LE(40);
        expect(Math.round((dataBytes / 2 / 24000) * 1000)).toBeCloseTo(expectedDurationMs(text), -1);
      }
    });

    it('xác thực đúng kiểu và văn bản gửi đi là UTF-8 chuẩn NFC', async () => {
      const decomposed = 'Tiếng Việt'.normalize('NFD');
      await fx.provider.synthesize({ ...fx.request, text: decomposed }, ctxFor('ok'));
      const sent = mock.requests.find((r) => r.method === 'POST')!;
      fx.checkAuth(sent.headers, API_KEY);
      expect(sent.body.includes('Tiếng Việt'.normalize('NFC')) || sent.body.includes(JSON.stringify('Tiếng Việt'.normalize('NFC')).slice(1, -1))).toBe(true);
      expect(sent.body.includes(decomposed)).toBe(false);
    });

    it('429 → lỗi tạm thời kèm retryAfter, lần gọi sau thành công', async () => {
      const err = await expectKind('429-then-ok', 'transient');
      expect(err.retryAfterMs).toBe(0);
      expect(err.retryable).toBe(true);
      const ok = await fx.provider.synthesize(fx.request, ctxFor('429-then-ok'));
      expect(looksLikeAudio(ok.audio)).toBe(true);
    });

    it('5xx liên tục → transient', async () => {
      expect((await expectKind('5xx', 'transient')).retryable).toBe(true);
    });

    it('401 → auth (không thử lại)', async () => {
      const err = await expectKind('401', 'auth');
      expect(err.retryable).toBe(false);
      expect(err.code).toBe('AUTH');
    });

    it('403 hết quota → quota (không thử lại)', async () => {
      const err = await expectKind('403-quota', 'quota');
      expect(err.retryable).toBe(false);
    });

    it('400 chính sách nội dung → content_blocked (không thử lại)', async () => {
      const err = await expectKind('400-policy', 'content_blocked');
      expect(err.retryable).toBe(false);
      expect(err.code).toBe('CONTENT_BLOCKED');
    });

    it('phản hồi hỏng → transient', async () => {
      await expectKind('malformed', 'transient');
    });

    it('quá thời gian chờ → transient', async () => {
      const err = await fx.provider.synthesize(fx.request, ctxFor('timeout', { timeoutMs: 300 })).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(ProviderError);
      expect((err as ProviderError).kind).toBe('transient');
    });

    it('hủy bằng AbortSignal giữa chừng → ném lỗi hủy (không phải ProviderError)', async () => {
      const ctrl = new AbortController();
      const p = fx.provider.synthesize(fx.request, ctxFor('timeout', { signal: ctrl.signal, timeoutMs: 20_000 }));
      setTimeout(() => ctrl.abort(), 100);
      const err = await p.then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(ProviderError);
    });

    it('văn bản ngoài giới hạn của nhà cung cấp → bad_request, không gọi mạng', async () => {
      const cat = fx.provider.catalog();
      const tooLong = 'a'.repeat(cat.maxCharsPerRequest + 1);
      await expectKind('ok', 'bad_request', { ...fx.request, text: tooLong });
      expect(mock.requests).toHaveLength(0);
      if (cat.minChars > 1) {
        await expectKind('ok', 'bad_request', { ...fx.request, text: 'a'.repeat(cat.minChars - 1) });
      }
    });

    it('thông điệp lỗi không bao giờ chứa khóa API', async () => {
      for (const scenario of ['401', '403-quota', '5xx', '400-policy', 'malformed']) {
        const err = (await fx.provider.synthesize(fx.request, ctxFor(scenario)).then(
          () => null,
          (e: unknown) => e,
        )) as Error;
        expect(err.message).not.toContain(API_KEY);
        expect(String(err.stack ?? '')).not.toContain(API_KEY);
      }
    });

    it('testConnection: thành công, và thất bại trả thông báo thân thiện (không lộ khóa)', async () => {
      const ok = await fx.provider.testConnection(ctxFor('ok'));
      expect(ok.ok).toBe(true);
      expect(ok.latencyMs).toBeGreaterThanOrEqual(0);
      const bad = await fx.provider.testConnection(ctxFor('401'));
      expect(bad.ok).toBe(false);
      expect(bad.message).not.toContain(API_KEY);
      expect(bad.message.length).toBeGreaterThan(5);
    });

    it.runIf(fx.supports.forbiddenModel)('model/giọng chưa được cấp quyền → forbidden_model', async () => {
      await expectKind('403-model', 'forbidden_model');
    });

    it.runIf(fx.supports.voiceInvalid)('giọng không hợp lệ → voice_invalid', async () => {
      await expectKind('400-voice', 'voice_invalid');
    });

    it.runIf(fx.supports.internalLink)('link audio trỏ về địa chỉ nội bộ/metadata → ssrf_blocked, không kết nối', async () => {
      const err = await expectKind('redirect-internal', 'ssrf_blocked');
      expect(err.retryable).toBe(false);
    });
  });
}
