import { pathParam, route, type RouteContext } from '@/lib/api/errors';
import { requireUser } from '@/lib/auth/guards';
import { deleteVideoJob, getVideoJobDetail } from '@/lib/video/service';

export const dynamic = 'force-dynamic';

/** Chi tiết việc dịch: media, bản xuất và nhật ký gần nhất. Việc của người khác → 404 (FR-056). */
export const GET = route(async (request: Request, ctx: RouteContext) => {
  const user = await requireUser(request);
  return Response.json(await getVideoJobDetail(user.id, await pathParam(ctx, 'jobId')));
});

/** Dừng, hủy phiên tải, xóa mọi tệp và trả dung lượng (FR-045, FR-057). */
export const DELETE = route(async (request: Request, ctx: RouteContext) => {
  const user = await requireUser(request);
  await deleteVideoJob(user.id, await pathParam(ctx, 'jobId'));
  return new Response(null, { status: 204 });
});
