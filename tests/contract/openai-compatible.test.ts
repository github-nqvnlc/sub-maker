import { describe, expect, it } from 'vitest';
import { startMockProvider } from '../../mock-provider/server';
import { OpenAiCompatibleProvider } from '@/lib/providers/adapters/openai-compatible';
import { createSafeFetch } from '@/lib/security/safe-fetch';
import { defineAdapterSuite } from './adapter-suite';

const provider = new OpenAiCompatibleProvider();

defineAdapterSuite({
  name: 'openai_compatible',
  provider,
  baseFor: (url, scenario) => `${url}/s/${scenario}/v1`,
  request: { text: 'Chào bạn, đây là kiểm thử OpenAI SDK.', model: 'tts-1', voice: 'alloy' },
  supports: { forbiddenModel: true, voiceInvalid: true },
  checkAuth: (headers, apiKey) => {
    expect(headers['authorization']).toBe(`Bearer ${apiKey}`);
    expect(headers['api_key']).toBeUndefined();
  },
});

describe('openai_compatible: đặc thù', () => {
  it('tự động xử lý endpoint khi baseUrl không có /v1', async () => {
    const mock = await startMockProvider();
    try {
      const res = await provider.synthesize(
        { text: 'Xin chào OpenAI không có /v1.', model: 'tts-1', voice: 'alloy' },
        { config: { baseUrl: `${mock.url}/s/ok`, apiKey: 'sk-test-openai-sdk' }, fetch: createSafeFetch({ allowInsecure: true }) },
      );
      expect(res.audio.length).toBeGreaterThan(100);
      const posts = mock.requests.filter((r) => r.method === 'POST');
      expect(posts[0]!.path).toContain('/v1/audio/speech');
    } finally {
      await mock.close();
    }
  });

  it('testConnection fallback sang GET /v1/models khi model là STT hoặc model tùy chỉnh', async () => {
    const mock = await startMockProvider();
    try {
      const res = await provider.testConnection({
        config: { baseUrl: `${mock.url}/s/403-model/v1`, apiKey: 'sk-test-openai-sdk' },
        fetch: createSafeFetch({ allowInsecure: true }),
      });
      // Với kịch bản 403-model, fallback GET /v1/models thành công
      expect(res.ok).toBe(true);
      expect(res.message).toContain('API key hợp lệ');
    } finally {
      await mock.close();
    }
  });
});
