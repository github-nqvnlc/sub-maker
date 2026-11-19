import { getCatalog } from '../catalog';
import { ProviderError, toProviderError } from '../errors';
import type { CallContext, ProviderCatalog, SynthesizeRequest, SynthesizeResult, TestResult, TtsProvider } from '../types';
import { callOk, charCount, joinUrl, readAudio } from './shared';

/**
 * FPT AI Marketplace (OpenAI-compatible) — docs/fpt-ai-voice-guide.md §4.
 * POST {base}/audio/speech trả nhị phân audio (đồng bộ). Xác thực: Authorization: Bearer.
 * Tên model phân biệt hoa/thường; voice KHÔNG dùng chéo giữa các model.
 */
export class FptMarketplaceProvider implements TtsProvider {
  readonly type = 'fpt_marketplace' as const;

  catalog(): ProviderCatalog {
    return getCatalog(this.type);
  }

  async synthesize(req: SynthesizeRequest, ctx: CallContext): Promise<SynthesizeResult> {
    const cat = this.catalog();
    const text = req.text.normalize('NFC').trim();
    const chars = charCount(text);
    if (chars < cat.minChars || chars > cat.maxCharsPerRequest) throw new ProviderError('bad_request');

    const body: Record<string, unknown> = {
      model: req.model ?? cat.models[0]!.id,
      voice: req.voice,
      input: text,
      response_format: 'wav',
    };
    // Chỉ gửi speed khi khác 1 (khoảng hợp lệ chưa kiểm chứng — Spike S3)
    if (req.speed != null && Number.isFinite(req.speed) && req.speed !== 1) body.speed = req.speed;

    const res = await callOk(ctx, joinUrl(ctx.config.baseUrl, '/audio/speech'), {
      method: 'POST',
      headers: { authorization: `Bearer ${ctx.config.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const { audio, mime } = await readAudio(res, 'audio/wav');
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
