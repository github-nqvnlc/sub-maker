import { ZodError } from 'zod';
import { env } from '../env';
import { vi, type ErrorCode } from '../i18n/vi';
import { getDict } from '../i18n';
import { localeFromCookieHeader, type Locale } from '../i18n/locale';
import { translateFields, translateMessage } from '../i18n/server-messages';

/**
 * Định dạng lỗi chuẩn: { error: { code, message, fields? } } (contracts/openapi.yaml).
 * Không bao giờ lộ chi tiết nội bộ hay khóa API.
 */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ErrorCode | string,
    message?: string,
    public readonly fields?: Record<string, string>,
  ) {
    super(message ?? (vi.errors as Record<string, string>)[code] ?? vi.errors.INTERNAL);
    this.name = 'HttpError';
  }
}

export const notFound = (message?: string) => new HttpError(404, 'NOT_FOUND', message);
export const unauthenticated = () => new HttpError(401, 'UNAUTHENTICATED');
export const conflict = (code: ErrorCode | string = 'CONFLICT', message?: string) => new HttpError(409, code, message);
export const validation = (fields?: Record<string, string>, message?: string) =>
  new HttpError(422, 'VALIDATION', message, fields);

export function errorResponse(status: number, code: string, message: string, fields?: Record<string, string>): Response {
  return Response.json({ error: { code, message, ...(fields ? { fields } : {}) } }, { status });
}

export function zodFields(err: ZodError): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of err.issues) {
    const key = issue.path.length ? issue.path.join('.') : '_';
    if (!(key in fields)) fields[key] = issue.message;
  }
  return fields;
}

/** Chuyển mọi lỗi bắt được thành Response chuẩn (500 không lộ chi tiết). */
export function toErrorResponse(err: unknown, locale: Locale = 'vi'): Response {
  // `code` không đổi theo ngôn ngữ; chỉ `message` và `fields` được dịch (spec 003, FR-022)
  if (err instanceof HttpError) return errorResponse(err.status, err.code, translateMessage(locale, err.message), translateFields(locale, err.fields));
  if (err instanceof ZodError) {
    return errorResponse(422, 'VALIDATION', getDict(locale).errors.VALIDATION, translateFields(locale, zodFields(err)));
  }
  console.error('[api] lỗi không mong đợi:', err instanceof Error ? `${err.name}: ${err.message}` : 'không rõ');
  return errorResponse(500, 'INTERNAL', getDict(locale).errors.INTERNAL);
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Chống CSRF (research R4): mọi yêu cầu ghi dùng cookie phiên phải có Origin khớp APP_URL.
 * Thiếu hoặc sai Origin → 403.
 */
export function assertSameOrigin(request: Request): void {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return;
  const origin = request.headers.get('origin');
  if (!origin) throw new HttpError(403, 'FORBIDDEN_ORIGIN');
  let expected: string;
  try {
    expected = new URL(env().APP_URL).origin;
  } catch {
    throw new HttpError(403, 'FORBIDDEN_ORIGIN');
  }
  if (origin !== expected) throw new HttpError(403, 'FORBIDDEN_ORIGIN');
}

export type RouteContext = { params: Promise<Record<string, string | string[]>> };

type Handler<C> = (request: Request, ctx: C) => Promise<Response> | Response;

/** Đọc tham số đường dẫn dạng chuỗi (route động `[id]`); sai kiểu → 404. */
export async function pathParam(ctx: RouteContext, name: string): Promise<string> {
  const value = (await ctx.params)[name];
  if (typeof value !== 'string' || value.length === 0) throw notFound();
  return value;
}

/** Bộ bọc Route Handler: kiểm tra Origin + bắt lỗi → Response chuẩn. */
export function route<C = RouteContext>(handler: Handler<C>) {
  return async (request: Request, ctx: C): Promise<Response> => {
    try {
      assertSameOrigin(request);
      return await handler(request, ctx);
    } catch (err) {
      return toErrorResponse(err, localeFromCookieHeader(request.headers.get('cookie')));
    }
  };
}

/** Đọc JSON body an toàn; sai định dạng → 422. */
export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new HttpError(422, 'VALIDATION', vi.errors.VALIDATION, { _: 'Nội dung gửi lên phải là JSON hợp lệ' });
  }
}
