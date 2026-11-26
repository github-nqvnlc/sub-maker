import { pathParam, readJson, route, type RouteContext } from '@/lib/api/errors';
import { requireUser } from '@/lib/auth/guards';
import { reuploadSource } from '@/lib/video/uploads';

export const dynamic = 'force-dynamic';

/** Phiên tải lại video nguồn đã xóa; tệp khác trả `FILE_MISMATCH` (FR-046). */
export const POST = route(async (request: Request, ctx: RouteContext) => {
  const user = await requireUser(request);
  return Response.json(await reuploadSource(user, await pathParam(ctx, 'jobId'), await readJson(request)), { status: 201 });
});
