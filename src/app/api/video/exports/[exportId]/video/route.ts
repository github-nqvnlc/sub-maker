import { pathParam, route, type RouteContext } from '@/lib/api/errors';
import { requireUser } from '@/lib/auth/guards';
import { serveExport } from '@/lib/video/exports';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Tải thành phẩm (`?inline=true` để phát trong trang); hỗ trợ Range. */
export const GET = route(async (request: Request, ctx: RouteContext) => {
  const user = await requireUser(request);
  return serveExport(user.id, await pathParam(ctx, 'exportId'), request);
});
