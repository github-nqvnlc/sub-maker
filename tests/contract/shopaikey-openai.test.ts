import { describe, expect, it } from 'vitest';
import { startMockProvider } from '../../mock-provider/server';
import { ShopAIKeyOpenAiProvider } from '@/lib/providers/adapters/shopaikey-openai';
import { createSafeFetch } from '@/lib/security/safe-fetch';
import { defineAdapterSuite } from './adapter-suite';

const provider = new ShopAIKeyOpenAiProvider();

defineAdapterSuite({
  name: 'shopaikey_openai',
  provider,
  baseFor: (url, scenario) => `${url}/s/${scenario}`,
  request: { text: 'Chào bạn, đây là ShopAIKey.', model: 'tts-1', voice: 'alloy' },
  // 503 "No available channel for model … under group …" được phân loại là forbidden_model
  supports: { forbiddenModel: true, internalLink: true },
  checkAuth: (headers, apiKey) => {
    expect(headers['authorization']).toBe(`Bearer ${apiKey}`);
    expect(headers['api_key']).toBeUndefined();
  },
});

describe('shopaikey_openai: đặc thù', () => {
  it('tải audio từ URL do nhà cung cấp trả về (hai bước: JSON rồi tải file)', async () => {
    const mock = await startMockProvider();
    try {
      const res = await provider.synthesize(
        { text: 'Tải file từ URL.', model: 'tts-1', voice: 'nova', speed: 1.1 },
        { config: { baseUrl: `${mock.url}/s/ok`, apiKey: 'sk-shopaikey-test-000' }, fetch: createSafeFetch({ allowInsecure: true }) },
      );
      expect(res.audio.length).toBeGreaterThan(100);
      const posts = mock.requests.filter((r) => r.method === 'POST');
      const gets = mock.requests.filter((r) => r.method === 'GET');
      expect(posts).toHaveLength(1);
      expect(gets).toHaveLength(1);
      expect(JSON.parse(posts[0]!.body)).toMatchObject({ input: 'Tải file từ URL.', model: 'tts-1', voice: 'nova', speed: 1.1 });
    } finally {
      await mock.close();
    }
  });
});
