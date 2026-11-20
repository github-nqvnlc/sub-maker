import { z } from 'zod';
import { pathParam, route, validation, type RouteContext } from '@/lib/api/errors';
import { requireUser } from '@/lib/auth/guards';
import { listCues } from '@/lib/projects/files';

export const dynamic = 'force-dynamic';

const querySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(100),
});

/** Xem trước cue (mốc bắt đầu–kết thúc và chữ đọc) theo trang; chỉ chủ sở hữu tệp (spec 003, FR-011). */
export const GET = route(async (request: Request, ctx: RouteContext) => {
  const user = await requireUser(request);
  const fileId = await pathParam(ctx, 'fileId');
  const q = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!q.success) throw validation({ page: 'Trang hoặc kích thước trang không hợp lệ' });
  return Response.json(await listCues(user.id, fileId, q.data.page, q.data.pageSize));
});
