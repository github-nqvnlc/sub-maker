import { notFound, route, type RouteContext } from '@/lib/api/errors';
import { requireUser } from '@/lib/auth/guards';
import { deleteConfig } from '@/lib/providers/config-service';
import { providerTypeParam } from '@/lib/providers/route-helpers';

export const dynamic = 'force-dynamic';

export const DELETE = route(async (request: Request, ctx: RouteContext) => {
  const user = await requireUser(request);
  if (!user.canUseCustomAi) throw notFound();
  const type = await providerTypeParam(ctx);
  if (!(await deleteConfig('user', user.id, type))) throw notFound();
  return new Response(null, { status: 204 });
});
