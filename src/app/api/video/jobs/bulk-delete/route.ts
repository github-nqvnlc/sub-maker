import { readJson, route } from '@/lib/api/errors';
import { requireUser } from '@/lib/auth/guards';
import { idsBodySchema } from '@/lib/schemas/common';
import { deleteVideoJobsBulk } from '@/lib/video/service';

export const dynamic = 'force-dynamic';

const body = idsBodySchema.strict();

/** Xóa nhiều việc dịch cùng mọi tệp của chúng (FR-045). Không cần quyền Dịch Video: xóa dữ liệu của mình. */
export const POST = route(async (request: Request) => {
  const user = await requireUser(request);
  const { ids } = body.parse(await readJson(request));
  return Response.json(await deleteVideoJobsBulk(user.id, [...new Set(ids)]));
});
