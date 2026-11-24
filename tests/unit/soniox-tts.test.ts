import { describe, expect, it, vi } from 'vitest';
import { SonioxTtsProvider } from '../../src/lib/providers/adapters/soniox-tts';
import { getCatalog, resolveSettings } from '../../src/lib/providers/catalog';
import { fetchSonioxVoices } from '../../src/lib/providers/soniox-voices';
import type { CallContext } from '../../src/lib/providers/types';

type SonioxPayload = {
  model?: string;
  text?: string;
  voice?: string;
  language?: string;
  speed?: number;
  audio_format?: string;
};

describe('Soniox TTS', () => {
  const provider = new SonioxTtsProvider();

  // 16-byte dummy valid MP3 frame
  const mockMp3Bytes = new Uint8Array([
    0xff, 0xfb, 0x90, 0x64,
    0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
  ]);

  it('catalog chứa model tts-rt-v2 và cấu hình speed 0.7 - 1.3', () => {
    const catalog = getCatalog('soniox');
    expect(catalog.type).toBe('soniox');
    expect(catalog.models.map((m) => m.id)).toContain('tts-rt-v2');
    expect(catalog.speed.min).toBe(0.7);
    expect(catalog.speed.max).toBe(1.3);
    expect(catalog.speed.step).toBe(0.05);

    const resolved = resolveSettings('soniox', {});
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.value.voice).toBe('Daniel');
      expect(resolved.value.model).toBe('tts-rt-v2');
      expect(resolved.value.speed).toBe(1.0);
    }
  });

  it('gửi payload JSON chuẩn đến endpoint tts-rt-v2 với Bearer token và nhận audio mp3', async () => {
    let capturedUrl = '';
    let capturedBody: SonioxPayload | null = null;
    let capturedHeaders: Record<string, string> = {};

    const mockFetch = vi.fn().mockImplementation(async (url: string, init: RequestInit) => {
      capturedUrl = url;
      capturedHeaders = init.headers as Record<string, string>;
      capturedBody = JSON.parse(init.body as string) as SonioxPayload;
      return new Response(mockMp3Bytes, {
        status: 200,
        headers: { 'content-type': 'audio/mpeg' },
      });
    });

    const ctx: CallContext = {
      config: {
        baseUrl: 'https://api.soniox.com',
        apiKey: 'test-soniox-key',
      },
      fetch: mockFetch as unknown as typeof fetch,
    };

    const result = await provider.synthesize(
      {
        text: 'Xin chào các bạn, chào mừng đến với Sub Maker.',
        model: 'tts-rt-v2',
        voice: 'Daniel',
        speed: 1.05,
      },
      ctx
    );

    expect(capturedUrl).toBe('https://tts-rt.soniox.com/tts');
    expect(capturedHeaders['authorization']).toBe('Bearer test-soniox-key');
    expect(capturedBody).toEqual({
      model: 'tts-rt-v2',
      text: 'Xin chào các bạn, chào mừng đến với Sub Maker.',
      voice: 'Daniel',
      language: 'vi', // Tự động nhận diện tiếng Việt
      speed: 1.05,
      audio_format: 'mp3',
    });
    expect(result.mime).toBe('audio/mpeg');
    expect(result.audio.length).toBe(16);
  });

  it('nhận diện ngôn ngữ en cho văn bản tiếng Anh hoặc tôn trọng ngôn ngữ truyền vào', async () => {
    const captured: { body?: SonioxPayload } = {};
    const mockFetch = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      captured.body = JSON.parse(init.body as string) as SonioxPayload;
      return new Response(mockMp3Bytes, {
        status: 200,
        headers: { 'content-type': 'audio/mpeg' },
      });
    });

    const ctx: CallContext = {
      config: { baseUrl: 'https://tts-rt.soniox.com', apiKey: 'test-key' },
      fetch: mockFetch as unknown as typeof fetch,
    };

    // English text -> language: 'en'
    await provider.synthesize({ text: 'Hello world, welcome to Sub Maker.', voice: 'Daniel' }, ctx);
    expect(captured.body?.language).toBe('en');

    // Explicit language override -> 'vi'
    await provider.synthesize({ text: 'Hello world', voice: 'Daniel', language: 'vi' }, ctx);
    expect(captured.body?.language).toBe('vi');
  });

  it('fetchSonioxVoices kết hợp voice console và shared-voices thành công', async () => {
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/shared-voices')) {
        return new Response(
          JSON.stringify({
            voices: [
              { id: 'shared-1', name: 'Daniel' },
              { id: 'shared-2', name: 'Emily' },
            ],
          }),
          { status: 200 }
        );
      }
      if (url.includes('/v1/voices')) {
        return new Response(
          JSON.stringify({
            voices: [
              { id: 'custom-123', name: 'My Cloned Voice' },
            ],
          }),
          { status: 200 }
        );
      }
      return new Response('Not found', { status: 404 });
    });

    const voices = await fetchSonioxVoices(undefined, {
      apiKey: 'fake-key',
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(voices.length).toBeGreaterThanOrEqual(3);
    const customVoice = voices.find((v) => v.id === 'custom-123');
    expect(customVoice).toBeDefined();
    expect(customVoice?.label).toContain('My Cloned Voice');
    expect(customVoice?.isCustom).toBe(true);
  });
});
