import { notFound, route, type RouteContext } from '@/lib/api/errors';
import { requireUser } from '@/lib/auth/guards';
import { testConfig } from '@/lib/providers/config-service';
import { providerTypeParam } from '@/lib/providers/route-helpers';

export const dynamic = 'force-dynamic';

export const POST = route(async (request: Request, ctx: RouteContext) => {
  const user = await requireUser(request);
  if (!user.canUseCustomAi) throw notFound();
  const type = await providerTypeParam(ctx);
  return Response.json(await testConfig('user', user.id, type));
});
