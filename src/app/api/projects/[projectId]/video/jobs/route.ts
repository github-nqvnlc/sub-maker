import { pathParam, readJson, route, type RouteContext } from '@/lib/api/errors';
import { requireUser } from '@/lib/auth/guards';
import { createVideoJob, listVideoJobs } from '@/lib/video/service';

export const dynamic = 'force-dynamic';

/** Các việc dịch video của Project. Project của người khác → 404. */
export const GET = route(async (request: Request, ctx: RouteContext) => {
  const user = await requireUser(request);
  return Response.json(await listVideoJobs(user.id, await pathParam(ctx, 'projectId')));
});

/** Tạo việc và phiên tải video nguồn (spec 006, FR-004, FR-007, FR-008). */
export const POST = route(async (request: Request, ctx: RouteContext) => {
  const user = await requireUser(request);
  return Response.json(await createVideoJob(user, await pathParam(ctx, 'projectId'), await readJson(request)), { status: 201 });
});
