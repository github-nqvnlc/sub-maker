import { pathParam, route, type RouteContext } from '@/lib/api/errors';
import { requireUser } from '@/lib/auth/guards';
import { cancelUpload, uploadState } from '@/lib/video/uploads';

export const dynamic = 'force-dynamic';

/** Phiên tải và các phần đã nhận, để tải tiếp. `size` và `fingerprint` của tệp đang chọn được đối chiếu (FR-005). */
export const GET = route(async (request: Request, ctx: RouteContext) => {
  const user = await requireUser(request);
  const query = new URL(request.url).searchParams;
  return Response.json(await uploadState(user.id, await pathParam(ctx, 'uploadId'), { size: query.get('size'), fingerprint: query.get('fingerprint') }));
});

/** Hủy phiên tải; video mới chưa có kịch bản thì xóa luôn việc. */
export const DELETE = route(async (request: Request, ctx: RouteContext) => {
  const user = await requireUser(request);
  await cancelUpload(user.id, await pathParam(ctx, 'uploadId'));
  return new Response(null, { status: 204 });
});
