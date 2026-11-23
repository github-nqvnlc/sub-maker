import { pathParam, readJson, route, type RouteContext } from '@/lib/api/errors';
import { requireAdmin } from '@/lib/auth/guards';
import {
  countPendingJobs,
  customProviderInputSchema,
  deleteCustomProvider,
  updateCustomProvider,
} from '@/lib/providers/custom-provider-service';

export const dynamic = 'force-dynamic';

/** Số voice job chưa bắt đầu đang dùng provider (cho hộp thoại xác nhận xóa). */
export const GET = route(async (request: Request, ctx: RouteContext) => {
  await requireAdmin(request);
  return Response.json({ pendingJobs: await countPendingJobs(await pathParam(ctx, 'providerId')) });
});

/** Sửa provider; tắt provider thì job chưa bắt đầu chuyển `failed` (US5-AS4). */
export const PUT = route(async (request: Request, ctx: RouteContext) => {
  await requireAdmin(request);
  const input = customProviderInputSchema.parse(await readJson(request));
  return Response.json(await updateCustomProvider(await pathParam(ctx, 'providerId'), input));
});

/** Xóa provider: job chưa bắt đầu chuyển `failed`, job đang chạy hoàn tất bình thường (US5-AS4). */
export const DELETE = route(async (request: Request, ctx: RouteContext) => {
  await requireAdmin(request);
  return Response.json(await deleteCustomProvider(await pathParam(ctx, 'providerId')));
});
