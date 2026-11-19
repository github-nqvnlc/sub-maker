import { route } from '@/lib/api/errors';
import { requireUser } from '@/lib/auth/guards';
import { getDashboard, rangeQuerySchema, resolveRange } from '@/lib/usage/aggregate';

export const dynamic = 'force-dynamic';

/** Thống kê cá nhân của chính User đang đăng nhập (FR-038): luôn lọc theo `user.id` từ phiên, không nhận từ client. */
export const GET = route(async (request: Request) => {
  const user = await requireUser(request);
  const q = rangeQuerySchema.parse(Object.fromEntries(new URL(request.url).searchParams));
  return Response.json(await getDashboard(user.id, resolveRange(q)));
});
