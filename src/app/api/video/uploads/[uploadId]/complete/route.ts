import { pathParam, route, type RouteContext } from '@/lib/api/errors';
import { requireUser } from '@/lib/auth/guards';
import { getOwnedVideoJob, toDto } from '@/lib/video/service';
import { completeUpload } from '@/lib/video/uploads';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Ghép các phần, kiểm dung lượng và nhận diện tệp, xếp việc chuẩn bị. Gọi lại an toàn. */
export const POST = route(async (request: Request, ctx: RouteContext) => {
  const user = await requireUser(request);
  const { jobId } = await completeUpload(user, await pathParam(ctx, 'uploadId'));
  return Response.json(await toDto(await getOwnedVideoJob(user.id, jobId)));
});
