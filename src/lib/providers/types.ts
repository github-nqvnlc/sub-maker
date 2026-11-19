import type { SafeFetch } from '../security/safe-fetch';
import type { ProviderType } from '../schemas/common';

export type { ProviderType };

export type SynthesizeRequest = {
  text: string;
  model?: string | null;
  voice: string;
  /** Thang tốc độ theo từng nhà cung cấp (xem catalog.speed). */
  speed?: number | null;
};

export type PollingOptions = {
  /** Khoảng chờ đầu tiên giữa các lần polling (ms). Mặc định 1500. */
  initialMs?: number;
  /** Khoảng chờ tối đa (ms). Mặc định 8000. */
  maxMs?: number;
  /** Tổng thời gian chờ link async (ms). Mặc định 150000 (~2,5 phút theo tài liệu FPT). */
  timeoutMs?: number;
};

/** Ngữ cảnh một lần gọi. Khóa API đã giải mã chỉ sống trong bộ nhớ, không được ghi log. */
export type CallContext = {
  config: { baseUrl: string; apiKey: string };
  signal?: AbortSignal;
  /** safeFetch (chống SSRF); KHÔNG dùng fetch toàn cục trong adapter. */
  fetch: SafeFetch;
  polling?: PollingOptions;
};

export type SynthesizeResult = {
  audio: Uint8Array;
  /** wav | mpeg … — worker giải mã về PCM chuẩn bằng ffmpeg. */
  mime: string;
  /** Số ký tự Unicode đã gửi (đơn vị tính phí của TTS). */
  unitsChars: number;
  /** Chỉ điền khi nhà cung cấp trả về; không bịa số. */
  unitsTokens?: number;
  providerRequestId?: string;
};

export type TestResult = { ok: boolean; message: string; latencyMs: number };

export type VoiceInfo = {
  id: string;
  label: string;
  gender: 'female' | 'male' | 'neutral';
  region: 'north' | 'central' | 'south' | '';
};

export type ModelInfo = { id: string; label: string; voices: VoiceInfo[] };

export type ProviderCatalog = {
  type: ProviderType;
  label: string;
  defaultBaseUrl: string;
  models: ModelInfo[];
  speed: { min: number; max: number; default: number; step: number };
  /** Giới hạn mỗi yêu cầu theo tài liệu nhà cung cấp. */
  maxCharsPerRequest: number;
  minChars: number;
};

export interface TtsProvider {
  readonly type: ProviderType;
  catalog(): ProviderCatalog;
  synthesize(req: SynthesizeRequest, ctx: CallContext): Promise<SynthesizeResult>;
  testConnection(ctx: CallContext): Promise<TestResult>;
}
