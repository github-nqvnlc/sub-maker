import { pathParam, route, type RouteContext } from '@/lib/api/errors';
import { requireUser } from '@/lib/auth/guards';
import { stopOverlayJob } from '@/lib/overlay/service';

export const dynamic = 'force-dynamic';

/** Dừng tiến trình xuất đang chờ, đang chạy hoặc bị gián đoạn. Đã kết thúc → 409. */
export const POST = route(async (request: Request, ctx: RouteContext) => {
  const user = await requireUser(request);
  return Response.json(await stopOverlayJob(user.id, await pathParam(ctx, 'jobId')));
});
