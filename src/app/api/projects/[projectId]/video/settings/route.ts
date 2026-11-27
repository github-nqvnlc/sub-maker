import { pathParam, readJson, route, type RouteContext } from '@/lib/api/errors';
import { requireUser } from '@/lib/auth/guards';
import { saveProjectVideoSettings } from '@/lib/video/settings-service';

export const dynamic = 'force-dynamic';

/** Hướng dịch, từ điển và kiểu gần nhất của dịch video trong một Project (FR-019, FR-031). */
export const PUT = route(async (request: Request, ctx: RouteContext) => {
  const user = await requireUser(request);
  return Response.json(await saveProjectVideoSettings(user.id, await pathParam(ctx, 'projectId'), await readJson(request)));
});
