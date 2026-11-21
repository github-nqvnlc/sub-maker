import { getCatalog } from '../catalog';
import { ProviderError, toProviderError } from '../errors';
import type { CallContext, ProviderCatalog, SynthesizeRequest, SynthesizeResult, TestResult, TtsProvider } from '../types';
import { callOk, charCount, joinUrl, readAudio } from './shared';

/**
 * OpenAI Compatible Provider — Tuân theo chuẩn OpenAI SDK (Audio Speech & Models).
 * Dùng cho mọi nhà cung cấp API key có hỗ trợ OpenAI API (OpenAI official, Groq, Deepgram, ShopAIKey proxy, v.v.).
 * Endpoint TTS: POST {baseUrl}/audio/speech hoặc {baseUrl}/v1/audio/speech
 * Xác thực: Authorization: Bearer <apiKey>
 * Phản hồi: Binary audio trực tiếp (mp3/wav) hoặc JSON audio/url đối với một số proxy.
 */
export class OpenAiCompatibleProvider implements TtsProvider {
  readonly type = 'openai_compatible' as const;

  catalog(): ProviderCatalog {
    return getCatalog(this.type);
  }

  private resolveEndpoint(baseUrl: string, path: string): string {
    const clean = baseUrl.replace(/\/+$/, '');
    const cleanPath = path.startsWith('/') ? path : `/${path}`;
    if (clean.endsWith(cleanPath)) return clean;
    if (clean.endsWith('/v1')) return `${clean}${cleanPath}`;
    return joinUrl(clean, cleanPath.startsWith('/v1') ? cleanPath : `/v1${cleanPath}`);
  }

  async synthesize(req: SynthesizeRequest, ctx: CallContext): Promise<SynthesizeResult> {
    const cat = this.catalog();
    const text = req.text.normalize('NFC').trim();
    const chars = charCount(text);
    if (chars < cat.minChars || chars > cat.maxCharsPerRequest) throw new ProviderError('bad_request');

    const speechUrl = this.resolveEndpoint(ctx.config.baseUrl, '/audio/speech');

    const res = await callOk(ctx, speechUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${ctx.config.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        input: text,
        model: req.model ?? cat.models[0]!.id,
        voice: req.voice,
        response_format: 'mp3',
        speed: req.speed ?? 1,
      }),
    });

    const contentType = (res.headers.get('content-type') ?? '').toLowerCase();

    // Chuẩn OpenAI SDK: phản hồi nhị phân trực tiếp (audio/mpeg, audio/wav, v.v.)
    if (!contentType.includes('application/json')) {
      const { audio, mime } = await readAudio(res, 'audio/mpeg');
      return { audio, mime, unitsChars: chars };
    }

    // Một số proxy trả về JSON (chứa link url tải file hoặc base64 audio)
    let json: { url?: string; audio?: string; data?: Array<{ b64_json?: string; url?: string }> };
    try {
      json = (await res.json()) as typeof json;
    } catch {
      throw new ProviderError('transient');
    }

    if (json.url && typeof json.url === 'string') {
      const file = await callOk(ctx, json.url, { method: 'GET' });
      const { audio, mime } = await readAudio(file, 'audio/mpeg');
      return { audio, mime, unitsChars: chars };
    }

    const b64 = json.audio ?? json.data?.[0]?.b64_json;
    if (b64 && typeof b64 === 'string') {
      const audio = new Uint8Array(Buffer.from(b64, 'base64'));
      return { audio, mime: 'audio/mpeg', unitsChars: chars };
    }

    throw new ProviderError('transient');
  }

  async testConnection(ctx: CallContext): Promise<TestResult> {
    const started = Date.now();
    const cat = this.catalog();
    try {
      // 1. Thử gọi speech endpoint với câu chào ngắn
      const m = cat.models[0]!;
      await this.synthesize({ text: 'Xin chào.', model: m.id, voice: m.voices[0]!.id }, ctx);
      return { ok: true, message: 'Kết nối thành công (OpenAI TTS sẵn sàng)', latencyMs: Date.now() - started };
    } catch (e) {
      if (ctx.signal?.aborted) throw e;
      const err = toProviderError(e);

      // Nếu lỗi là do model không hợp lệ (ví dụ key chỉ có STT hoặc model tùy chỉnh), thử GET /models
      if (err.kind === 'forbidden_model' || err.kind === 'bad_request') {
        try {
          const modelsUrl = this.resolveEndpoint(ctx.config.baseUrl, '/models');
          const res = await callOk(ctx, modelsUrl, {
            method: 'GET',
            headers: { authorization: `Bearer ${ctx.config.apiKey}` },
          });
          if (res.ok) {
            return { ok: true, message: 'Kết nối thành công (API key hợp lệ theo chuẩn OpenAI)', latencyMs: Date.now() - started };
          }
        } catch {
          // Bỏ qua lỗi fallback và trả về lỗi gốc
        }
      }

      return { ok: false, message: err.message, latencyMs: Date.now() - started };
    }
  }
}
