import { pathParam, readJson, route, type RouteContext } from '@/lib/api/errors';
import { requireUser } from '@/lib/auth/guards';
import { saveAsScript } from '@/lib/video/subtitle-service';

export const dynamic = 'force-dynamic';

/** Lưu phụ đề đã duyệt thành kịch bản `.srt` của Project (FR-040). */
export const POST = route(async (request: Request, ctx: RouteContext) => {
  const user = await requireUser(request);
  return Response.json(await saveAsScript(user.id, await pathParam(ctx, 'jobId'), await readJson(request)), { status: 201 });
});
