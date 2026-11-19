import { z } from 'zod';
import { route } from '@/lib/api/errors';
import { requireAdmin } from '@/lib/auth/guards';
import { paginationSchema } from '@/lib/schemas/common';
import { listUsers } from '@/lib/users/admin-service';

export const dynamic = 'force-dynamic';

const querySchema = paginationSchema.extend({
  q: z.string().max(200).optional(),
  status: z.enum(['active', 'banned', 'deleting']).optional(),
  customAi: z.enum(['true', 'false']).optional(),
});

export const GET = route(async (request: Request) => {
  await requireAdmin(request);
  const url = new URL(request.url);
  const q = querySchema.parse(Object.fromEntries(url.searchParams));
  const { items, total } = await listUsers({
    q: q.q,
    status: q.status,
    customAi: q.customAi === undefined ? undefined : q.customAi === 'true',
    page: q.page,
    pageSize: q.pageSize,
  });
  return Response.json({ items, total, page: q.page, pageSize: q.pageSize });
});
