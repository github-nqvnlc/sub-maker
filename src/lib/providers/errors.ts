import { SsrfError } from '../security/safe-fetch';

/**
 * Phân loại lỗi nhà cung cấp dùng chung (contracts/tts-provider.md). Quyết định worker xử lý thế nào:
 * `transient` được thử lại có backoff; mọi loại còn lại là vĩnh viễn, KHÔNG thử lại.
 * Thông điệp cho người dùng KHÔNG bao giờ chứa khóa, URL có khóa hay phản hồi thô.
 */
export type ProviderErrorKind =
  | 'transient'
  | 'auth'
  | 'quota'
  | 'forbidden_model'
  | 'voice_invalid'
  | 'content_blocked'
  | 'bad_request'
  | 'ssrf_blocked';

/** Mã lỗi ngắn lưu ở job_segments.error_code / voice_jobs.error_code. */
export const ERROR_CODE: Record<ProviderErrorKind, string> = {
  transient: 'TRANSIENT',
  auth: 'AUTH',
  quota: 'QUOTA',
  forbidden_model: 'FORBIDDEN_MODEL',
  voice_invalid: 'VOICE_INVALID',
  content_blocked: 'CONTENT_BLOCKED',
  bad_request: 'BAD_REQUEST',
  ssrf_blocked: 'SSRF_BLOCKED',
};

export const PROVIDER_ERROR_MESSAGE: Record<ProviderErrorKind, string> = {
  transient: 'Nhà cung cấp đang quá tải hoặc không phản hồi.',
  auth: 'Khóa API không hợp lệ. Hãy kiểm tra lại cấu hình nhà cung cấp.',
  quota: 'Tài khoản nhà cung cấp đã hết hạn mức hoặc số dư.',
  forbidden_model: 'Cấu hình chưa được cấp quyền dùng model hoặc giọng đọc này.',
  voice_invalid: 'Giọng đọc không hợp lệ cho model đã chọn.',
  content_blocked: 'Nội dung bị nhà cung cấp từ chối theo chính sách an toàn.',
  bad_request: 'Yêu cầu không được nhà cung cấp chấp nhận.',
  ssrf_blocked: 'Địa chỉ nhà cung cấp không được phép. Hãy kiểm tra lại địa chỉ gốc.',
};

export class ProviderError extends Error {
  constructor(
    public readonly kind: ProviderErrorKind,
    public readonly retryAfterMs?: number,
    public readonly httpStatus?: number,
  ) {
    super(PROVIDER_ERROR_MESSAGE[kind]);
    this.name = 'ProviderError';
  }
  get code(): string {
    return ERROR_CODE[this.kind];
  }
  get retryable(): boolean {
    return this.kind === 'transient';
  }
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const secs = Number(header);
  if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, 60_000);
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.min(Math.max(0, date - Date.now()), 60_000);
  return undefined;
}

/** Ánh xạ phản hồi HTTP lỗi sang loại lỗi. `body` chỉ dùng để phân loại, không bao giờ lộ ra ngoài. */
export function classifyHttpError(status: number, body: string, retryAfter?: string | null): ProviderError {
  const text = body.toLowerCase();
  if (status === 401) return new ProviderError('auth', undefined, status);
  if (status === 429) return new ProviderError('transient', parseRetryAfter(retryAfter ?? null) ?? 0, status);
  if (status === 408 || status === 425 || (status >= 500 && status <= 599)) {
    if (/no available channel|not supported|no access to model|unknown model/.test(text)) {
      return new ProviderError('forbidden_model', undefined, status);
    }
    return new ProviderError('transient', parseRetryAfter(retryAfter ?? null), status);
  }
  if (status === 403) {
    if (/quota|insufficient|balance|credit|exceed/.test(text)) return new ProviderError('quota', undefined, status);
    return new ProviderError('forbidden_model', undefined, status);
  }
  if (status === 404) {
    if (/model|channel|not supported/.test(text)) return new ProviderError('forbidden_model', undefined, status);
    return new ProviderError('bad_request', undefined, status);
  }
  if (status === 400) {
    if (/content management policy|content[_ ]policy|safety|moderation/.test(text)) {
      return new ProviderError('content_blocked', undefined, status);
    }
    if (/voice/.test(text) && /(not available|invalid|valid voices|unsupported|not supported)/.test(text)) {
      return new ProviderError('voice_invalid', undefined, status);
    }
    if (/quota|insufficient/.test(text)) return new ProviderError('quota', undefined, status);
    return new ProviderError('bad_request', undefined, status);
  }
  return new ProviderError('bad_request', undefined, status);
}

/** Chuyển lỗi mạng/safeFetch/hủy thành ProviderError (hoặc giữ nguyên nếu đã là ProviderError). */
export function toProviderError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  if (err instanceof SsrfError) {
    // Quá lớn/hết giờ/lỗi mạng là tạm thời; còn lại là địa chỉ bị chặn
    if (err.code === 'TIMEOUT') return new ProviderError('transient');
    if (err.code === 'RESPONSE_TOO_LARGE' || err.code === 'REDIRECT_BLOCKED') return new ProviderError('bad_request');
    return new ProviderError('ssrf_blocked');
  }
  // Lỗi mạng (ECONNRESET, ENOTFOUND, socket hang up …) → tạm thời
  return new ProviderError('transient');
}

export function isAbort(err: unknown, signal?: AbortSignal): boolean {
  return !!signal?.aborted || (err instanceof Error && (err.name === 'AbortError' || (err as { code?: string }).code === 'ABORT_ERR'));
}
