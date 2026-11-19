import { getCatalog } from '../catalog';
import { ProviderError, toProviderError } from '../errors';
import type { CallContext, ProviderCatalog, SynthesizeRequest, SynthesizeResult, TestResult, TtsProvider } from '../types';
import { callOk, charCount, joinUrl, looksLikeAudio, mimeFor } from './shared';

/**
 * ShopAIKey — MiniMax TTS (docs/shopaikey-guide.md §11.3; kiểm chứng bằng khóa thật ngày 2026-11-19).
 * POST {base}/tts/minimax/t2a_v2 (đồng bộ). Xác thực: Authorization: Bearer.
 * Phản hồi JSON: `data.audio` là audio dạng HEX, `base_resp.status_code` = 0 khi thành công.
 * LƯU Ý: MiniMax có thể trả HTTP 200 kèm `base_resp.status_code` ≠ 0 (lỗi nghiệp vụ) nên phải đọc cả hai.
 * Đơn vị tính phí: số ký tự (`usage_characters`); ta tự đếm ký tự Unicode đã gửi để thống nhất giữa các adapter.
 */
export class ShopAIKeyMiniMaxProvider implements TtsProvider {
  readonly type = 'shopaikey_minimax' as const;

  catalog(): ProviderCatalog {
    return getCatalog(this.type);
  }

  async synthesize(req: SynthesizeRequest, ctx: CallContext): Promise<SynthesizeResult> {
    const cat = this.catalog();
    const text = req.text.normalize('NFC').trim();
    const chars = charCount(text);
    if (chars < cat.minChars || chars > cat.maxCharsPerRequest) throw new ProviderError('bad_request');

    const speed = Math.max(cat.speed.min, Math.min(cat.speed.max, req.speed ?? cat.speed.default));
    const res = await callOk(ctx, joinUrl(ctx.config.baseUrl, '/tts/minimax/t2a_v2'), {
      method: 'POST',
      headers: { authorization: `Bearer ${ctx.config.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: req.model ?? cat.models[0]!.id,
        text,
        stream: false,
        language_boost: 'Vietnamese',
        voice_setting: { voice_id: req.voice, speed, vol: 1, pitch: 0 },
        audio_setting: { sample_rate: 24000, format: 'wav', channel: 1 },
      }),
    });

    let json: MiniMaxResponse;
    try {
      json = (await res.json()) as MiniMaxResponse;
    } catch {
      throw new ProviderError('transient'); // phản hồi hỏng
    }

    const code = json.base_resp?.status_code;
    if (typeof code === 'number' && code !== 0) throw classifyMiniMaxCode(code, json.base_resp?.status_msg ?? '');

    const hex = json.data?.audio;
    if (typeof hex !== 'string' || hex.length < 32 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) {
      throw new ProviderError('transient');
    }
    const audio = new Uint8Array(Buffer.from(hex, 'hex'));
    if (!looksLikeAudio(audio)) throw new ProviderError('transient');
    return { audio, mime: mimeFor(audio, null, 'audio/wav'), unitsChars: chars, providerRequestId: json.trace_id };
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

type MiniMaxResponse = {
  data?: { audio?: string };
  base_resp?: { status_code?: number; status_msg?: string };
  trace_id?: string;
};

/** Ánh xạ mã lỗi nghiệp vụ của MiniMax (`base_resp.status_code`) sang loại lỗi dùng chung. */
export function classifyMiniMaxCode(code: number, message: string): ProviderError {
  switch (code) {
    case 1004: // xác thực thất bại
    case 2049: // API key không hợp lệ
      return new ProviderError('auth');
    case 1008: // không đủ số dư
      return new ProviderError('quota');
    case 1026: // nội dung đầu vào nhạy cảm
    case 1027: // nội dung đầu ra nhạy cảm
      return new ProviderError('content_blocked');
    case 1000: // lỗi không xác định
    case 1001: // hết giờ
    case 1002: // giới hạn tốc độ
    case 1013: // lỗi dịch vụ nội bộ
    case 1039: // giới hạn TPM
    case 1041: // giới hạn kết nối
      return new ProviderError('transient', code === 1002 || code === 1039 ? 0 : undefined);
    case 2013: // tham số không hợp lệ
      return new ProviderError(/voice/i.test(message) ? 'voice_invalid' : 'bad_request');
    default:
      return new ProviderError('bad_request');
  }
}
