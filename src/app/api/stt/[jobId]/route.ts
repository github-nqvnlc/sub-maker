import { pathParam, route, type RouteContext } from '@/lib/api/errors';
import { requireUser } from '@/lib/auth/guards';
import { getSttJobDetail } from '@/lib/stt/service';

export const dynamic = 'force-dynamic';

/** Trạng thái, tiến độ, kết quả và 50 dòng nhật ký gần nhất của STT job (spec 004, US3, FR-020). Job của người khác → 404. */
export const GET = route(async (request: Request, ctx: RouteContext) => {
  const user = await requireUser(request);
  return Response.json(await getSttJobDetail(user.id, await pathParam(ctx, 'jobId')));
});
