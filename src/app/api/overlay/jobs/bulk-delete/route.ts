import { readJson, route } from '@/lib/api/errors';
import { requireUser } from '@/lib/auth/guards';
import { deleteOverlayJobs } from '@/lib/overlay/service';
import { idsBodySchema } from '@/lib/schemas/common';

export const dynamic = 'force-dynamic';

const body = idsBodySchema.strict();

/** Xóa một hoặc nhiều lần xuất; tiến trình đang chạy được dừng trước; trả lại hạn mức (spec 005, FR-042, FR-043). */
export const POST = route(async (request: Request) => {
  const user = await requireUser(request);
  const { ids } = body.parse(await readJson(request));
  return Response.json(await deleteOverlayJobs(user.id, [...new Set(ids)]));
});
