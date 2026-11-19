import { notFound, route, type RouteContext } from '@/lib/api/errors';
import { requireAdmin } from '@/lib/auth/guards';
import { deleteConfig } from '@/lib/providers/config-service';
import { providerTypeParam } from '@/lib/providers/route-helpers';

export const dynamic = 'force-dynamic';

export const DELETE = route(async (request: Request, ctx: RouteContext) => {
  await requireAdmin(request);
  const type = await providerTypeParam(ctx);
  if (!(await deleteConfig('global', null, type))) throw notFound();
  return new Response(null, { status: 204 });
});
