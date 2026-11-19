/**
 * Làm sạch chuỗi trước khi ghi log/trả cho người dùng: không để lộ khóa API hay URL có tham số khóa
 * (Nguyên tắc II). Dùng cho log tiến trình, thông báo lỗi và mọi nơi có thể chứa phản hồi thô.
 */
const MASK = '[đã ẩn]';

const PATTERNS: Array<[RegExp, string]> = [
  // Authorization: Bearer xxx
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]{6,}/gi, `$1${MASK}`],
  // ?key=xxx, &api_key=xxx, token=xxx, access_token=...
  [/([?&;\s](?:key|api[_-]?key|apikey|token|access[_-]?token|secret|password)=)[^&\s"']+/gi, `$1${MASK}`],
  // header api_key: xxx / x-api-key: xxx
  [/((?:^|\s|")(?:x-)?api[_-]?key"?\s*[:=]\s*"?)[^\s",}]{6,}/gi, `$1${MASK}`],
  // khóa dạng sk-... (OpenAI-like / ShopAIKey / Marketplace)
  [/\bsk-[A-Za-z0-9_-]{8,}/g, MASK],
];

export function redactSecrets(text: string, knownSecrets: readonly string[] = []): string {
  let out = text;
  for (const s of knownSecrets) {
    if (s && s.length >= 6) out = out.split(s).join(MASK);
  }
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}

/** Làm sạch đệ quy mọi chuỗi trong một đối tượng JSON (dùng cho `meta` của log). */
export function redactDeep<T>(value: T, knownSecrets: readonly string[] = []): T {
  if (typeof value === 'string') return redactSecrets(value, knownSecrets) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, knownSecrets)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // khóa tên nhạy cảm → che luôn giá trị
      out[k] = /^(api[_-]?key|authorization|token|secret|password)$/i.test(k) ? MASK : redactDeep(v, knownSecrets);
    }
    return out as T;
  }
  return value;
}
