import { pathParam, route, type RouteContext } from '@/lib/api/errors';
import { requireAdmin } from '@/lib/auth/guards';
import { testCustomProvider } from '@/lib/providers/custom-provider-service';

export const dynamic = 'force-dynamic';

export const POST = route(async (request: Request, ctx: RouteContext) => {
  await requireAdmin(request);
  return Response.json(await testCustomProvider(await pathParam(ctx, 'providerId')));
});
