/**
 * Gọi API từ trình duyệt: đọc định dạng lỗi chuẩn `{ error: { code, message, fields } }`,
 * tự điều hướng về trang đăng nhập khi 401.
 */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly fields?: Record<string, string>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

type Init = Omit<RequestInit, 'body'> & { json?: unknown; body?: BodyInit | null };

export async function api<T = unknown>(path: string, init: Init = {}): Promise<T> {
  const { json, headers, ...rest } = init;
  const h = new Headers(headers);
  let body = rest.body ?? undefined;
  if (json !== undefined) {
    h.set('content-type', 'application/json');
    body = JSON.stringify(json);
  }
  const res = await fetch(path, { ...rest, headers: h, body, credentials: 'same-origin' });

  if (res.status === 401 && typeof window !== 'undefined' && !window.location.pathname.startsWith('/login')) {
    // Tải lại toàn trang có chủ đích khi phiên hết hạn (không dùng được router ngoài component).
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.href = `/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`;
  }
  if (res.status === 204) return undefined as T;

  const text = await res.text();
  let data: unknown = undefined;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = undefined;
    }
  }
  if (!res.ok) {
    const e = (data as { error?: { code?: string; message?: string; fields?: Record<string, string> } } | undefined)?.error;
    throw new ApiError(res.status, e?.code ?? 'UNKNOWN', e?.message ?? res.statusText, e?.fields);
  }
  return data as T;
}

export const apiGet = <T>(path: string) => api<T>(path);
export const apiPost = <T>(path: string, json?: unknown) => api<T>(path, { method: 'POST', json: json ?? {} });
export const apiPut = <T>(path: string, json?: unknown) => api<T>(path, { method: 'PUT', json });
export const apiPatch = <T>(path: string, json?: unknown) => api<T>(path, { method: 'PATCH', json });
export const apiDelete = <T>(path: string) => api<T>(path, { method: 'DELETE' });
