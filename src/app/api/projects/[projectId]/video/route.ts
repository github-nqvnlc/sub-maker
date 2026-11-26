import { pathParam, route, type RouteContext } from '@/lib/api/errors';
import { requireUser } from '@/lib/auth/guards';
import { getVideoTab } from '@/lib/video/service';

export const dynamic = 'force-dynamic';

/** Tab "Dịch Video": quyền, hạn mức video, giới hạn, Soniox đã cấu hình chưa và cài đặt của Project (spec 006). */
export const GET = route(async (request: Request, ctx: RouteContext) => {
  const user = await requireUser(request);
  return Response.json(await getVideoTab(user, await pathParam(ctx, 'projectId')));
});
