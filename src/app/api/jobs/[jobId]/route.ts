import { conflict, notFound, pathParam, readJson, route, type RouteContext } from '@/lib/api/errors';
import { requireUser } from '@/lib/auth/guards';
import { deleteJobs } from '@/lib/jobs/delete';
import { settingsPatchSchema, updateJobSettings } from '@/lib/jobs/manage';
import { getJobDetail } from '@/lib/jobs/service';

export const dynamic = 'force-dynamic';

export const GET = route(async (request: Request, ctx: RouteContext) => {
  const user = await requireUser(request);
  return Response.json(await getJobDetail(user.id, await pathParam(ctx, 'jobId')));
});

/** Sửa thiết lập (model/giọng/tốc độ). Chỉ khi stopped/failed/interrupted; đổi thiết lập thì đưa mọi đoạn về pending. */
export const PATCH = route(async (request: Request, ctx: RouteContext) => {
  const user = await requireUser(request);
  const patch = settingsPatchSchema.parse(await readJson(request));
  return Response.json(await updateJobSettings(user, await pathParam(ctx, 'jobId'), patch));
});

/** Xóa tiến trình và voice kèm theo; đang chờ/chạy → 409 (hãy dừng trước). */
export const DELETE = route(async (request: Request, ctx: RouteContext) => {
  const user = await requireUser(request);
  const id = await pathParam(ctx, 'jobId');
  const r = await deleteJobs(user.id, [id], { stopFirst: false });
  if (r.notFound.includes(id)) throw notFound();
  if (r.rejectedRunning.includes(id)) throw conflict('CONFLICT', 'Tiến trình đang chờ hoặc đang chạy. Hãy dừng trước khi xóa.');
  return new Response(null, { status: 204 });
});
