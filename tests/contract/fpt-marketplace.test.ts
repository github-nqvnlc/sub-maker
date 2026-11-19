import { describe, expect, it } from 'vitest';
import { startMockProvider } from '../../mock-provider/server';
import { FptMarketplaceProvider } from '@/lib/providers/adapters/fpt-marketplace';
import { createSafeFetch } from '@/lib/security/safe-fetch';
import { defineAdapterSuite } from './adapter-suite';

const provider = new FptMarketplaceProvider();

defineAdapterSuite({
  name: 'fpt_marketplace',
  provider,
  baseFor: (url, scenario) => `${url}/s/${scenario}/v1`,
  request: { text: 'Chào bạn, đây là FPT Marketplace.', model: 'FPT.AI-VITs', voice: 'banmai' },
  supports: { forbiddenModel: true, voiceInvalid: true },
  checkAuth: (headers, apiKey) => {
    expect(headers['authorization']).toBe(`Bearer ${apiKey}`);
    expect(headers['api_key']).toBeUndefined();
    expect(String(headers['content-type'])).toContain('application/json');
  },
});

describe('fpt_marketplace: đặc thù', () => {
  const ctx = (url: string) => ({
    config: { baseUrl: `${url}/s/ok/v1`, apiKey: 'sk-marketplace-test-000' },
    fetch: createSafeFetch({ allowInsecure: true }),
  });

  it('gửi đúng model/voice/response_format; chỉ gửi speed khi khác 1', async () => {
    const mock = await startMockProvider();
    try {
      await provider.synthesize({ text: 'Tốc độ bình thường.', model: 'FPT.TTS-pro', voice: 'std_banmai', speed: 1 }, ctx(mock.url));
      await provider.synthesize({ text: 'Tốc độ nhanh hơn.', model: 'FPT.TTS-pro', voice: 'std_banmai', speed: 1.2 }, ctx(mock.url));
      const [a, b] = mock.requests.filter((r) => r.method === 'POST').map((r) => JSON.parse(r.body));
      expect(a).toMatchObject({ model: 'FPT.TTS-pro', voice: 'std_banmai', response_format: 'wav' });
      expect(a).not.toHaveProperty('speed');
      expect(b.speed).toBe(1.2);
    } finally {
      await mock.close();
    }
  });

  it('dùng model đầu tiên của catalog khi không chỉ định', async () => {
    const mock = await startMockProvider();
    try {
      await provider.synthesize({ text: 'Mặc định.', voice: 'banmai' }, ctx(mock.url));
      expect(JSON.parse(mock.requests.find((r) => r.method === 'POST')!.body).model).toBe('FPT.AI-VITs');
    } finally {
      await mock.close();
    }
  });
});
