import { pathParam, route, type RouteContext } from '@/lib/api/errors';
import { requireUser } from '@/lib/auth/guards';
import { stopExport } from '@/lib/video/exports';

export const dynamic = 'force-dynamic';

/** Dừng bản xuất đang chờ hoặc đang chạy. */
export const POST = route(async (request: Request, ctx: RouteContext) => {
  const user = await requireUser(request);
  return Response.json(await stopExport(user.id, await pathParam(ctx, 'exportId')));
});
