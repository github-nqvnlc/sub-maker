import { z } from 'zod';
import { readJson, route } from '@/lib/api/errors';
import { requireAdmin } from '@/lib/auth/guards';
import { uuidSchema } from '@/lib/schemas/common';
import { listUsers, updateUser } from '@/lib/users/admin-service';

export const dynamic = 'force-dynamic';

/** Danh sách User được phép dùng cấu hình AI riêng (FR-042), có tìm kiếm. */
export const GET = route(async (request: Request) => {
  await requireAdmin(request);
  const q = new URL(request.url).searchParams.get('q') ?? undefined;
  const { items } = await listUsers({ q: q?.slice(0, 200), customAi: true, page: 1, pageSize: 100 });
  return Response.json(items);
});

export const POST = route(async (request: Request) => {
  await requireAdmin(request);
  const { userId } = z.object({ userId: uuidSchema }).strict().parse(await readJson(request));
  await updateUser(userId, { canUseCustomAi: true });
  return new Response(null, { status: 204 });
});
