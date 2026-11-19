import { z } from 'zod';
import { pathParam, readJson, route, type RouteContext, validation } from '@/lib/api/errors';
import { requireAdmin } from '@/lib/auth/guards';
import { startDeleteUser, updateUser } from '@/lib/users/admin-service';

export const dynamic = 'force-dynamic';

const patchSchema = z
  .object({
    status: z.enum(['active', 'banned']).optional(),
    canUseCustomAi: z.boolean().optional(),
  })
  .strict();

export const PATCH = route(async (request: Request, ctx: RouteContext) => {
  await requireAdmin(request);
  const userId = await pathParam(ctx, 'userId');
  const body = patchSchema.parse(await readJson(request));
  if (body.status === undefined && body.canUseCustomAi === undefined) throw validation({ _: 'Không có thay đổi nào' });
  return Response.json(await updateUser(userId, body));
});

export const DELETE = route(async (request: Request, ctx: RouteContext) => {
  await requireAdmin(request);
  const userId = await pathParam(ctx, 'userId');
  const confirm = new URL(request.url).searchParams.get('confirm');
  if (!confirm) throw validation({ confirm: 'Thiếu xác nhận' });
  await startDeleteUser(userId, confirm);
  return new Response(null, { status: 202 });
});
