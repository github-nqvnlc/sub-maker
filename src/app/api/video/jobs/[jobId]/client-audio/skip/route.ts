import { pathParam, route, type RouteContext } from '@/lib/api/errors';
import { requireUser } from '@/lib/auth/guards';
import { skipClientAudio } from '@/lib/video/uploads';

export const dynamic = 'force-dynamic';

/** Bỏ qua luồng nhanh từ trình duyệt; máy chủ sẽ tách âm thanh khi video tải xong (FR-010). */
export const POST = route(async (request: Request, ctx: RouteContext) => {
  const user = await requireUser(request);
  return Response.json(await skipClientAudio(user, await pathParam(ctx, 'jobId')));
});

