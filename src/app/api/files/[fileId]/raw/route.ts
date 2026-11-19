import { notFound, pathParam, route, type RouteContext } from '@/lib/api/errors';
import { requireUser } from '@/lib/auth/guards';
import { getOwnedFile } from '@/lib/projects/access';
import { serveObject } from '@/lib/storage/proxy';

export const dynamic = 'force-dynamic';

/** Tải file gốc đã upload (qua proxy có kiểm tra chủ sở hữu). */
export const GET = route(async (request: Request, ctx: RouteContext) => {
  const user = await requireUser(request);
  const file = await getOwnedFile(user.id, await pathParam(ctx, 'fileId'));
  const res = await serveObject(file.storageKey, {
    contentType: 'text/plain; charset=utf-8',
    downloadName: file.originalName,
    rangeHeader: request.headers.get('range'),
  });
  if (res.status === 404) throw notFound();
  return res;
});
