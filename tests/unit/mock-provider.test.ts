import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectedDurationMs, makeWav, startMockProvider, type MockProvider } from '../../mock-provider/server';

let mock: MockProvider;

beforeAll(async () => {
  mock = await startMockProvider();
});
afterAll(async () => {
  await mock.close();
});

const post = (path: string, init: RequestInit) => fetch(mock.url + path, { method: 'POST', ...init });

describe('mock provider', () => {
  it('makeWav tạo WAV hợp lệ có độ dài đúng', () => {
    const wav = makeWav(1000, 24000);
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.readUInt32LE(24)).toBe(24000);
    expect(wav.readUInt32LE(40)).toBe(24000 * 2);
  });

  it('Marketplace trả nhị phân WAV, độ dài theo số ký tự', async () => {
    const res = await post('/s/ok/v1/audio/speech', {
      headers: { authorization: 'Bearer k', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'FPT.AI-VITs', voice: 'banmai', input: 'Xin chào' }),
    });
    expect(res.status).toBe(200);
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.readUInt32LE(40)).toBe(Math.round((expectedDurationMs('Xin chào') / 1000) * 24000) * 2);
  });

  it('429-then-ok: lần đầu 429, lần sau thành công', async () => {
    const init = { headers: { authorization: 'Bearer k' }, body: JSON.stringify({ input: 'abc' }) };
    expect((await post('/s/429-then-ok/tts/openai/speech', init)).status).toBe(429);
    expect((await post('/s/429-then-ok/tts/openai/speech', init)).status).toBe(200);
  });

  it('thiếu khóa → 401; 403-quota và 400-policy trả đúng thông điệp', async () => {
    expect((await post('/s/ok/tts/openai/speech', { body: '{}' })).status).toBe(401);
    const quota = await post('/s/403-quota/tts/openai/speech', { headers: { authorization: 'Bearer k' }, body: '{}' });
    expect(quota.status).toBe(403);
    const policy = await post('/s/400-policy/v1/audio/speech', {
      headers: { authorization: 'Bearer k' },
      body: JSON.stringify({ input: 'x' }),
    });
    expect(policy.status).toBe(400);
    expect(JSON.stringify(await policy.json())).toContain('content management policy');
  });

  it('policy-marker chỉ chặn văn bản chứa [BLOCK]', async () => {
    const ok = await post('/s/policy-marker/v1/audio/speech', {
      headers: { authorization: 'Bearer k' },
      body: JSON.stringify({ input: 'bình thường' }),
    });
    const blocked = await post('/s/policy-marker/v1/audio/speech', {
      headers: { authorization: 'Bearer k' },
      body: JSON.stringify({ input: 'nội dung [BLOCK]' }),
    });
    expect([ok.status, blocked.status]).toEqual([200, 400]);
  });

  it('ghi lại yêu cầu để kiểm tra header xác thực', async () => {
    mock.reset();
    await post('/s/ok/v1/audio/speech', { headers: { authorization: 'Bearer secret-key', 'content-type': 'application/json' }, body: JSON.stringify({ model: 'FPT.AI-VITs', voice: 'banmai', input: 'Chào' }) });
    expect(mock.requests).toHaveLength(1);
    expect(mock.requests[0]!.headers['authorization']).toBe('Bearer secret-key');
  });
});
