import { z } from 'zod';
import { pathParam, route, type RouteContext } from '@/lib/api/errors';
import { requireUser } from '@/lib/auth/guards';
import { readLogs } from '@/lib/jobs/service';

export const dynamic = 'force-dynamic';

const query = z.object({
  after: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

/** Đọc log theo con trỏ (dự phòng khi SSE không dùng được). */
export const GET = route(async (request: Request, ctx: RouteContext) => {
  const user = await requireUser(request);
  const q = query.parse(Object.fromEntries(new URL(request.url).searchParams));
  return Response.json(await readLogs(user.id, await pathParam(ctx, 'jobId'), q.after, q.limit));
});
