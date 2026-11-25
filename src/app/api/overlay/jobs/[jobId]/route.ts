import { pathParam, route, type RouteContext } from '@/lib/api/errors';
import { requireUser } from '@/lib/auth/guards';
import { getOverlayJobDetail } from '@/lib/overlay/service';

export const dynamic = 'force-dynamic';

/** Chi tiết một lần xuất: cấu hình đã chốt, tiến độ và nhật ký gần nhất (spec 005, FR-039). */
export const GET = route(async (request: Request, ctx: RouteContext) => {
  const user = await requireUser(request);
  return Response.json(await getOverlayJobDetail(user.id, await pathParam(ctx, 'jobId')));
});
