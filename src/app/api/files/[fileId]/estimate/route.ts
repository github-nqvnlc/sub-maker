import { pathParam, readJson, route, type RouteContext } from '@/lib/api/errors';
import { requireUser } from '@/lib/auth/guards';
import { estimateBodySchema, estimateFile } from '@/lib/jobs/estimate';

export const dynamic = 'force-dynamic';

/** Ước tính trước khi tạo voice (số ký tự, yêu cầu, thời lượng, dung lượng, thời gian, tiền nếu đã có đơn giá). Không gọi nhà cung cấp. */
export const POST = route(async (request: Request, ctx: RouteContext) => {
  const user = await requireUser(request);
  const fileId = await pathParam(ctx, 'fileId');
  const body = estimateBodySchema.parse(await readJson(request));
  return Response.json(await estimateFile(user, fileId, body));
});
