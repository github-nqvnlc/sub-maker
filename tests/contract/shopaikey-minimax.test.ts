import { describe, expect, it } from 'vitest';
import { startMockProvider } from '../../mock-provider/server';
import { ShopAIKeyMiniMaxProvider, classifyMiniMaxCode } from '@/lib/providers/adapters/shopaikey-minimax';
import { ProviderError } from '@/lib/providers/errors';
import { createSafeFetch } from '@/lib/security/safe-fetch';
import { defineAdapterSuite } from './adapter-suite';

const provider = new ShopAIKeyMiniMaxProvider();

defineAdapterSuite({
  name: 'shopaikey_minimax',
  provider,
  baseFor: (url, scenario) => `${url}/s/${scenario}`,
  request: { text: 'Chào bạn, đây là MiniMax.', model: 'speech-02-hd', voice: 'Vietnamese_female_4_v1' },
  supports: { forbiddenModel: true, voiceInvalid: true },
  checkAuth: (headers, apiKey) => {
    expect(headers['authorization']).toBe(`Bearer ${apiKey}`);
    expect(headers['api_key']).toBeUndefined();
  },
});

describe('shopaikey_minimax: đặc thù', () => {
  const ctx = (mockUrl: string, scenario: string) => ({
    config: { baseUrl: `${mockUrl}/s/${scenario}`, apiKey: 'sk-minimax-test-000' },
    fetch: createSafeFetch({ allowInsecure: true }),
  });

  it('HTTP 200 nhưng base_resp báo lỗi → phân loại đúng; audio hỏng → lỗi tạm thời', async () => {
    const mock = await startMockProvider();
    try {
      const expectKind = async (scenario: string, kind: string) => {
        const e = await provider
          .synthesize({ text: 'Lỗi nghiệp vụ.', model: 'speech-02-hd', voice: 'Vietnamese_female_4_v1' }, ctx(mock.url, scenario))
          .catch((x: unknown) => x);
        expect(e, scenario).toBeInstanceOf(ProviderError);
        expect((e as ProviderError).kind, scenario).toBe(kind);
      };
      await expectKind('mm-1004', 'auth');
      await expectKind('mm-2049', 'auth');
      await expectKind('mm-1008', 'quota');
      await expectKind('mm-1026', 'content_blocked');
      await expectKind('mm-1002', 'transient');
      await expectKind('mm-1039', 'transient');
      await expectKind('mm-2013', 'bad_request');
      await expectKind('mm-9999', 'bad_request');
      await expectKind('bad-hex', 'transient');
    } finally {
      await mock.close();
    }
  });

  it('classifyMiniMaxCode: 2013 nhắc tới giọng → voice_invalid; rate limit được thử lại ngay (retryAfter 0)', () => {
    expect(classifyMiniMaxCode(2013, 'invalid params, voice id not exist').kind).toBe('voice_invalid');
    expect(classifyMiniMaxCode(2013, 'invalid params, text empty').kind).toBe('bad_request');
    expect(classifyMiniMaxCode(1002, '').retryAfterMs).toBe(0);
  });
});
