import { z } from 'zod';
import { route } from '@/lib/api/errors';
import { requireAdmin } from '@/lib/auth/guards';
import { STATS_SORTS, getAdminStats, rangeQuerySchema, resolveRange } from '@/lib/usage/aggregate';

export const dynamic = 'force-dynamic';

const query = rangeQuerySchema.extend({
  sort: z.enum(STATS_SORTS).default('chars'),
  order: z.enum(['asc', 'desc']).default('desc'),
});

/** Thống kê toàn hệ thống và từng User (FR-039). Chỉ số liệu tổng hợp, không có nội dung Project. */
export const GET = route(async (request: Request) => {
  await requireAdmin(request);
  const q = query.parse(Object.fromEntries(new URL(request.url).searchParams));
  return Response.json(await getAdminStats(resolveRange(q), q.sort, q.order));
});
