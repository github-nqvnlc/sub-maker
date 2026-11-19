import { z } from 'zod';
import { route } from '@/lib/api/errors';
import { requireUser } from '@/lib/auth/guards';
import { listMyJobs } from '@/lib/jobs/service';

export const dynamic = 'force-dynamic';

const query = z.object({
  status: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/** Tiến trình của tôi xuyên mọi Project (dùng cho chỉ báo tiến trình đang chạy). */
export const GET = route(async (request: Request) => {
  const user = await requireUser(request);
  const q = query.parse(Object.fromEntries(new URL(request.url).searchParams));
  return Response.json(await listMyJobs(user.id, q.status, q.limit));
});
