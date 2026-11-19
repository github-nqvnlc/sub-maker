import { z } from 'zod';
import { pathParam, readJson, route, type RouteContext } from '@/lib/api/errors';
import { requireAdmin } from '@/lib/auth/guards';
import { passwordSchema } from '@/lib/schemas/common';
import { resetUserPassword } from '@/lib/users/admin-service';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({ newPassword: passwordSchema }).strict();

export const POST = route(async (request: Request, ctx: RouteContext) => {
  await requireAdmin(request);
  const userId = await pathParam(ctx, 'userId');
  const body = bodySchema.parse(await readJson(request));
  await resetUserPassword(userId, body.newPassword);
  return new Response(null, { status: 204 });
});
