import { pathParam, route, type RouteContext } from '@/lib/api/errors';
import { requireUser } from '@/lib/auth/guards';
import { rerunOverlayJob } from '@/lib/overlay/service';

export const dynamic = 'force-dynamic';

/** Chạy lại tiến trình lỗi hoặc đã dừng với nội dung đã chốt lúc bấm xuất (spec 005, FR-042). */
export const POST = route(async (request: Request, ctx: RouteContext) => {
  const user = await requireUser(request);
  return Response.json(await rerunOverlayJob(user.id, await pathParam(ctx, 'jobId')));
});
