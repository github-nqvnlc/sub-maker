import { pathParam, route, type RouteContext } from '@/lib/api/errors';
import { requireUser } from '@/lib/auth/guards';
import { serveVideoMedia } from '@/lib/video/media';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** `?kind=source|preview|audio`, hỗ trợ Range. Chỉ chủ việc xem được; video không đi qua URL ký. */
export const GET = route(async (request: Request, ctx: RouteContext) => {
  const user = await requireUser(request);
  return serveVideoMedia(user.id, await pathParam(ctx, 'jobId'), new URL(request.url).searchParams.get('kind'), request);
});
