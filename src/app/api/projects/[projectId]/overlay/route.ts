import { pathParam, readJson, route, type RouteContext } from '@/lib/api/errors';
import { requireUser } from '@/lib/auth/guards';
import { getOverlayState, saveOverlayState } from '@/lib/overlay/service';

export const dynamic = 'force-dynamic';

/** Cấu hình overlay gần nhất của Project, nguồn đã chọn và giới hạn đang áp dụng (spec 005, FR-016). */
export const GET = route(async (request: Request, ctx: RouteContext) => {
  const user = await requireUser(request);
  return Response.json(await getOverlayState(user.id, await pathParam(ctx, 'projectId')));
});

/** Tự lưu cấu hình. */
export const PUT = route(async (request: Request, ctx: RouteContext) => {
  const user = await requireUser(request);
  await saveOverlayState(user.id, await pathParam(ctx, 'projectId'), await readJson(request));
  return new Response(null, { status: 204 });
});
