import { pathParam, readJson, route, type RouteContext } from '@/lib/api/errors';
import { requireUser } from '@/lib/auth/guards';
import { retranslateVideoJob } from '@/lib/video/retranslate';

export const dynamic = 'force-dynamic';

/** Dịch lại: thay toàn bộ phụ đề và phát sinh phí nên cần xác nhận cùng đúng phiên bản phụ đề (FR-016). */
export const POST = route(async (request: Request, ctx: RouteContext) => {
  const user = await requireUser(request);
  return Response.json(await retranslateVideoJob(user, await pathParam(ctx, 'jobId'), await readJson(request)), { status: 202 });
});
