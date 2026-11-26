import { pathParam, route, type RouteContext } from '@/lib/api/errors';
import { requireUser } from '@/lib/auth/guards';
import { rerunVideoJob } from '@/lib/video/service';

export const dynamic = 'force-dynamic';

/** Chạy lại việc lỗi hoặc đã dừng, dùng lại phần đã xong (FR-016, FR-050). */
export const POST = route(async (request: Request, ctx: RouteContext) => {
  const user = await requireUser(request);
  return Response.json(await rerunVideoJob(user, await pathParam(ctx, 'jobId')), { status: 202 });
});
