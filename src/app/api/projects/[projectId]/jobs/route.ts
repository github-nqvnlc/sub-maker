import { pathParam, readJson, route, type RouteContext } from '@/lib/api/errors';
import { requireUser } from '@/lib/auth/guards';
import { createJob, createJobSchema, listProjectJobs } from '@/lib/jobs/service';

export const dynamic = 'force-dynamic';

export const GET = route(async (request: Request, ctx: RouteContext) => {
  const user = await requireUser(request);
  return Response.json(await listProjectJobs(user.id, await pathParam(ctx, 'projectId')));
});

/** Bắt đầu tạo voice (FR-012, FR-015). Cấu hình AI được chọn lúc này. */
export const POST = route(async (request: Request, ctx: RouteContext) => {
  const user = await requireUser(request);
  const projectId = await pathParam(ctx, 'projectId');
  const input = createJobSchema.parse(await readJson(request));
  return Response.json(await createJob(user, projectId, input), { status: 202 });
});
