import { notFound, pathParam, route, type RouteContext } from '@/lib/api/errors';
import { requireUser } from '@/lib/auth/guards';
import { requestStop } from '@/lib/jobs/control';
import { getOwnedJob } from '@/lib/projects/access';

export const dynamic = 'force-dynamic';

/** Dừng tiến trình; giữ phần đã xong (FR-021). Đang chạy → dừng sau đoạn đang xử lý. */
export const POST = route(async (request: Request, ctx: RouteContext) => {
  const user = await requireUser(request);
  const job = await getOwnedJob(user.id, await pathParam(ctx, 'jobId'));
  const r = await requestStop(user.id, [job.id]);
  if (r.untouched.length > 0 && r.stopped.length === 0 && r.stopRequested.length === 0) {
    // đã kết thúc (completed/failed/stopped): không có gì để dừng
    if (job.status === 'completed') throw notFound();
  }
  return Response.json({ status: r.stopped.length ? 'stopped' : r.stopRequested.length ? 'stopping' : job.status }, { status: 202 });
});
