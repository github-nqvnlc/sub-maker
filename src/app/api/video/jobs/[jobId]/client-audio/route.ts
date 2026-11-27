import { pathParam, readJson, route, type RouteContext } from '@/lib/api/errors';
import { requireUser } from '@/lib/auth/guards';
import { createClientAudioUpload } from '@/lib/video/uploads';

export const dynamic = 'force-dynamic';

/** Mở phiên tải âm thanh do trình duyệt tách (≤ 500 MB) (spec 006, US9, FR-010). */
export const POST = route(async (request: Request, ctx: RouteContext) => {
  const user = await requireUser(request);
  return Response.json(await createClientAudioUpload(user, await pathParam(ctx, 'jobId'), await readJson(request)), { status: 201 });
});

