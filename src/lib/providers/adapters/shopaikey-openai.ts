import { getCatalog } from '../catalog';
import { ProviderError, toProviderError } from '../errors';
import type { CallContext, ProviderCatalog, SynthesizeRequest, SynthesizeResult, TestResult, TtsProvider } from '../types';
import { callOk, charCount, joinUrl, readAudio } from './shared';

/**
 * ShopAIKey — OpenAI TTS (docs/shopaikey-guide.md §11.1).
 * POST {base}/tts/openai/speech trả JSON chứa `url` audio (đã upload S3) ⇒ tải file qua safeFetch.
 * Xác thực: Authorization: Bearer. `input` tối đa 4096 ký tự; `speed` 0.25–4.0.
 */
export class ShopAIKeyOpenAiProvider implements TtsProvider {
  readonly type = 'shopaikey_openai' as const;

  catalog(): ProviderCatalog {
    return getCatalog(this.type);
  }

  async synthesize(req: SynthesizeRequest, ctx: CallContext): Promise<SynthesizeResult> {
    const cat = this.catalog();
    const text = req.text.normalize('NFC').trim();
    const chars = charCount(text);
    if (chars < cat.minChars || chars > cat.maxCharsPerRequest) throw new ProviderError('bad_request');

    const res = await callOk(ctx, joinUrl(ctx.config.baseUrl, '/tts/openai/speech'), {
      method: 'POST',
      headers: { authorization: `Bearer ${ctx.config.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        input: text,
        model: req.model ?? cat.models[0]!.id,
        voice: req.voice,
        response_format: 'wav',
        speed: req.speed ?? 1,
      }),
    });

    let json: { url?: string };
    try {
      json = (await res.json()) as typeof json;
    } catch {
      throw new ProviderError('transient');
    }
    if (!json.url || typeof json.url !== 'string') throw new ProviderError('transient');

    // Tải audio từ URL do nhà cung cấp trả về: BẮT BUỘC qua safeFetch (chặn địa chỉ nội bộ)
    const file = await callOk(ctx, json.url, { method: 'GET' });
    const { audio, mime } = await readAudio(file, 'audio/wav');
    return { audio, mime, unitsChars: chars };
  }

  async testConnection(ctx: CallContext): Promise<TestResult> {
    const started = Date.now();
    const cat = this.catalog();
    try {
      const m = cat.models[0]!;
      await this.synthesize({ text: 'Xin chào.', model: m.id, voice: m.voices[0]!.id }, ctx);
      return { ok: true, message: 'Kết nối thành công.', latencyMs: Date.now() - started };
    } catch (e) {
      if (ctx.signal?.aborted) throw e;
      return { ok: false, message: toProviderError(e).message, latencyMs: Date.now() - started };
    }
  }
}
