import { readJson, route } from '@/lib/api/errors';
import { requireUser } from '@/lib/auth/guards';
import { deleteProjects } from '@/lib/projects/delete';
import { idsBodySchema } from '@/lib/schemas/common';

export const dynamic = 'force-dynamic';

/** Xóa nhiều Project cùng toàn bộ dữ liệu liên quan; tiến trình đang chạy được dừng trước (FR-004). */
export const POST = route(async (request: Request) => {
  const user = await requireUser(request);
  const { ids } = idsBodySchema.strict().parse(await readJson(request));
  const r = await deleteProjects(user.id, [...new Set(ids)]);
  return Response.json({ deleted: r.deleted, notFound: r.notFound, busy: r.busy });
});
