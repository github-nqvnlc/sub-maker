import { pathParam, route, type RouteContext } from '@/lib/api/errors';
import { requireUser } from '@/lib/auth/guards';
import { deleteExport } from '@/lib/video/exports';

export const dynamic = 'force-dynamic';

/** Xóa một bản xuất và trả dung lượng. */
export const DELETE = route(async (request: Request, ctx: RouteContext) => {
  const user = await requireUser(request);
  await deleteExport(user.id, await pathParam(ctx, 'exportId'));
  return new Response(null, { status: 204 });
});
