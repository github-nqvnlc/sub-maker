import { pathParam, route, type RouteContext } from '@/lib/api/errors';
import { requireUser } from '@/lib/auth/guards';
import { stopVideoJob } from '@/lib/video/service';

export const dynamic = 'force-dynamic';

/** Dừng pipeline dịch đang chờ hoặc đang chạy. */
export const POST = route(async (request: Request, ctx: RouteContext) => {
  const user = await requireUser(request);
  return Response.json(await stopVideoJob(user.id, await pathParam(ctx, 'jobId')));
});
