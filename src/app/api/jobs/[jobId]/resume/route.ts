import { pathParam, route, type RouteContext } from '@/lib/api/errors';
import { requireUser } from '@/lib/auth/guards';
import { resumeJob } from '@/lib/jobs/manage';

export const dynamic = 'force-dynamic';

/** Tiếp tục tiến trình stopped/failed/interrupted từ đoạn chưa xong (đoạn đã xong không bị làm lại, không tốn phí lặp). */
export const POST = route(async (request: Request, ctx: RouteContext) => {
  const user = await requireUser(request);
  return Response.json(await resumeJob(user, await pathParam(ctx, 'jobId')), { status: 202 });
});
