import { pathParam, route, type RouteContext } from '@/lib/api/errors';
import { requireUser } from '@/lib/auth/guards';
import { deleteFile, getFileDetail } from '@/lib/projects/files';

export const dynamic = 'force-dynamic';

export const GET = route(async (request: Request, ctx: RouteContext) => {
  const user = await requireUser(request);
  return Response.json(await getFileDetail(user.id, await pathParam(ctx, 'fileId')));
});

export const DELETE = route(async (request: Request, ctx: RouteContext) => {
  const user = await requireUser(request);
  await deleteFile(user.id, await pathParam(ctx, 'fileId'));
  return new Response(null, { status: 204 });
});
