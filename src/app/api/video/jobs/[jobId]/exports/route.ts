import { pathParam, readJson, route, type RouteContext } from '@/lib/api/errors';
import { requireUser } from '@/lib/auth/guards';
import { createExport } from '@/lib/video/exports';

export const dynamic = 'force-dynamic';

/** Chốt nội dung và kiểu rồi tạo bản xuất (FR-042). */
export const POST = route(async (request: Request, ctx: RouteContext) => {
  const user = await requireUser(request);
  return Response.json(await createExport(user, await pathParam(ctx, 'jobId'), await readJson(request)), { status: 201 });
});
