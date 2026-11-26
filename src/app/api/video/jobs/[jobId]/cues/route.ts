import { pathParam, route, type RouteContext } from '@/lib/api/errors';
import { requireUser } from '@/lib/auth/guards';
import { getCues } from '@/lib/video/cues';

export const dynamic = 'force-dynamic';

/** Kịch bản phụ đề của một việc kèm số phiên bản. */
export const GET = route(async (request: Request, ctx: RouteContext) => {
  const user = await requireUser(request);
  return Response.json(await getCues(user.id, await pathParam(ctx, 'jobId')));
});
