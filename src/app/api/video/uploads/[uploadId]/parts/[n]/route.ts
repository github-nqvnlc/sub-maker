import { errorResponse, pathParam, route, type RouteContext } from '@/lib/api/errors';
import { requireUser } from '@/lib/auth/guards';
import { getDict } from '@/lib/i18n';
import { localeFromCookieHeader } from '@/lib/i18n/locale';
import { receivePart, RETRY_AFTER_SECONDS, UploadBusyError } from '@/lib/video/uploads';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Một phần của video (thân nhị phân thô, tối đa 16 MB), gửi lại được. Kiểm quyền và chủ sở hữu ở mỗi phần (FR-004). */
export const PUT = route(async (request: Request, ctx: RouteContext) => {
  const user = await requireUser(request);
  try {
    await receivePart(user, await pathParam(ctx, 'uploadId'), await pathParam(ctx, 'n'), request);
  } catch (e) {
    // trình duyệt tự ngắt (tạm dừng, mất mạng): không còn ai nhận phản hồi, không ghi thành lỗi máy chủ
    if (request.signal.aborted || (e as Error).name === 'AbortError') return new Response(null, { status: 499 });
    if (!(e instanceof UploadBusyError)) throw e;
    const response = errorResponse(429, 'UPLOAD_BUSY', getDict(localeFromCookieHeader(request.headers.get('cookie'))).errors.UPLOAD_BUSY);
    response.headers.set('retry-after', String(RETRY_AFTER_SECONDS));
    return response;
  }
  return new Response(null, { status: 204 });
});
