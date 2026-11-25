import { notFound, pathParam, route, type RouteContext } from '@/lib/api/errors';
import { requireUser } from '@/lib/auth/guards';
import { getOwnedOverlayJob, VIDEO_CONTENT_TYPE, videoFileName } from '@/lib/overlay/service';
import { serveObject } from '@/lib/storage/proxy';

export const dynamic = 'force-dynamic';

/** Tải video thành phẩm qua proxy CÓ KIỂM TRA CHỦ SỞ HỮU (Nguyên tắc I), hỗ trợ `Range`. Chưa hoàn tất → 404. */
export const GET = route(async (request: Request, ctx: RouteContext) => {
  const user = await requireUser(request);
  const job = await getOwnedOverlayJob(user.id, await pathParam(ctx, 'jobId'));
  if (job.status !== 'completed' || !job.outputStorageKey) throw notFound();
  const res = await serveObject(job.outputStorageKey, {
    contentType: VIDEO_CONTENT_TYPE[job.format],
    downloadName: videoFileName(job),
    rangeHeader: request.headers.get('range'),
  });
  if (res.status === 404) throw notFound();
  return res;
});
