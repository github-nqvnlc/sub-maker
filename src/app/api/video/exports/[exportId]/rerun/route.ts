import { pathParam, route, type RouteContext } from '@/lib/api/errors';
import { requireUser } from '@/lib/auth/guards';
import { rerunExport } from '@/lib/video/exports';

export const dynamic = 'force-dynamic';

/** Chạy lại bằng nội dung đã chốt. */
export const POST = route(async (request: Request, ctx: RouteContext) => {
  const user = await requireUser(request);
  return Response.json(await rerunExport(user, await pathParam(ctx, 'exportId')), { status: 202 });
});
