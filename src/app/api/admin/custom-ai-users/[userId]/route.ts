import { pathParam, route, type RouteContext } from '@/lib/api/errors';
import { requireAdmin } from '@/lib/auth/guards';
import { updateUser } from '@/lib/users/admin-service';

export const dynamic = 'force-dynamic';

/** Gỡ User khỏi danh sách: cấu hình riêng bị vô hiệu và giữ lại (FR-044), xử lý trong updateUser. */
export const DELETE = route(async (request: Request, ctx: RouteContext) => {
  await requireAdmin(request);
  await updateUser(await pathParam(ctx, 'userId'), { canUseCustomAi: false });
  return new Response(null, { status: 204 });
});
