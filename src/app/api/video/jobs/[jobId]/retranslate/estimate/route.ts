import { pathParam, route, type RouteContext } from '@/lib/api/errors';
import { requireUser } from '@/lib/auth/guards';
import { estimateRetranslate } from '@/lib/video/retranslate';

export const dynamic = 'force-dynamic';

/** Thời lượng và chi phí ước tính của một lượt dịch lại; chi phí là null khi chưa cấu hình đơn giá. */
export const POST = route(async (request: Request, ctx: RouteContext) => {
  const user = await requireUser(request);
  return Response.json(await estimateRetranslate(user.id, await pathParam(ctx, 'jobId')));
});
