import { pathParam, route, type RouteContext } from '@/lib/api/errors';
import { requireUser } from '@/lib/auth/guards';
import { rerunJob, settingsPatchSchema } from '@/lib/jobs/manage';

export const dynamic = 'force-dynamic';

/** Chạy lại: tạo tiến trình MỚI (thiết lập tùy chọn trong body); đoạn trùng được lấy từ cache (FR-022, FR-017). */
export const POST = route(async (request: Request, ctx: RouteContext) => {
  const user = await requireUser(request);
  const text = await request.text();
  const overrides = settingsPatchSchema.parse(text.trim() ? JSON.parse(text) : {});
  return Response.json(await rerunJob(user, await pathParam(ctx, 'jobId'), overrides), { status: 202 });
});
