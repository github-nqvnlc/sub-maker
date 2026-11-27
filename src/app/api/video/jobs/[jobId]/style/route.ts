import { pathParam, readJson, route, type RouteContext } from '@/lib/api/errors';
import { requireUser } from '@/lib/auth/guards';
import { saveJobStyle } from '@/lib/video/settings-service';

export const dynamic = 'force-dynamic';

/** Lưu kiểu phụ đề của việc và kiểu gần nhất của Project (FR-031). */
export const PUT = route(async (request: Request, ctx: RouteContext) => {
  const user = await requireUser(request);
  return Response.json(await saveJobStyle(user.id, await pathParam(ctx, 'jobId'), await readJson(request)));
});
