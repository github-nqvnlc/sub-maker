import { pathParam, readJson, route, type RouteContext } from '@/lib/api/errors';
import { requireUser } from '@/lib/auth/guards';
import { createOverlayJob, listOverlayJobs } from '@/lib/overlay/service';

export const dynamic = 'force-dynamic';

/** Các lần xuất video của Project (spec 005). Project của người khác → 404. */
export const GET = route(async (request: Request, ctx: RouteContext) => {
  const user = await requireUser(request);
  return Response.json(await listOverlayJobs(user.id, await pathParam(ctx, 'projectId')));
});

/** Tạo tiến trình xuất. Gửi lại cùng `clientRequestId` trả dòng cũ (200) nên bấm trùng không tạo hai tiến trình. */
export const POST = route(async (request: Request, ctx: RouteContext) => {
  const user = await requireUser(request);
  const { job, created } = await createOverlayJob(user, await pathParam(ctx, 'projectId'), await readJson(request));
  return Response.json(job, { status: created ? 201 : 200 });
});
