import { getCatalog } from '../catalog';
import { ProviderError } from '../errors';
import type { CallContext, ProviderCatalog, SynthesizeRequest, SynthesizeResult, TestResult, TtsProvider } from '../types';
import { callOk, charCount, readAudio } from './shared';

const VI_CHAR_REGEX = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i;

export class SonioxTtsProvider implements TtsProvider {
  readonly type = 'soniox' as const;

  catalog(): ProviderCatalog {
    return getCatalog(this.type);
  }

  private resolveEndpoint(baseUrl: string): string {
    const clean = baseUrl.replace(/\/+$/, '');
    if (clean.includes('api.soniox.com') || clean === 'https://tts-rt.soniox.com') {
      return 'https://tts-rt.soniox.com/tts';
    }
    return clean.endsWith('/tts') ? clean : `${clean}/tts`;
  }

  async synthesize(req: SynthesizeRequest, ctx: CallContext): Promise<SynthesizeResult> {
    const cat = this.catalog();
    const text = req.text.normalize('NFC').trim();
    const chars = charCount(text);
    if (chars < cat.minChars || (cat.maxCharsPerRequest > 0 && chars > cat.maxCharsPerRequest)) {
      throw new ProviderError('bad_request');
    }

    const language = req.language || (VI_CHAR_REGEX.test(text) ? 'vi' : 'en');
    const ttsUrl = this.resolveEndpoint(ctx.config.baseUrl);

    const res = await callOk(ctx, ttsUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${ctx.config.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: req.model ?? 'tts-rt-v2',
        text,
        voice: req.voice || 'Daniel',
        language,
        speed: req.speed ?? 1.0,
        audio_format: 'mp3',
      }),
    });

    const { audio, mime } = await readAudio(res, 'audio/mpeg');
    return { audio, mime, unitsChars: chars };
  }

  async testConnection(ctx: CallContext): Promise<TestResult> {
    const started = Date.now();
    try {
      await this.synthesize({ text: 'Xin chào.', model: 'tts-rt-v2', voice: 'Daniel' }, ctx);
      return { ok: true, message: 'Kết nối thành công (Soniox TTS sẵn sàng)', latencyMs: Date.now() - started };
    } catch (e) {
      if (ctx.signal?.aborted) throw e;
      const { toProviderError } = await import('../errors');
      const err = toProviderError(e);
      return { ok: false, message: `Lỗi kết nối Soniox: ${err.message || err.kind}`, latencyMs: Date.now() - started };
    }
  }
}
