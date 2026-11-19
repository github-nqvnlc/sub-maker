import { z } from 'zod';
import { readJson, route } from '@/lib/api/errors';
import { requireUser } from '@/lib/auth/guards';
import { deleteJobs } from '@/lib/jobs/delete';
import { idsBodySchema } from '@/lib/schemas/common';

export const dynamic = 'force-dynamic';

const body = idsBodySchema.extend({ stopFirst: z.boolean().default(false) }).strict();

/** Xóa nhiều tiến trình/voice (FR-023). Đang chờ/chạy bị từ chối trừ khi `stopFirst` (dừng rồi xóa). */
export const POST = route(async (request: Request) => {
  const user = await requireUser(request);
  const { ids, stopFirst } = body.parse(await readJson(request));
  const r = await deleteJobs(user.id, [...new Set(ids)], { stopFirst });
  return Response.json({ deleted: r.deleted, rejectedRunning: [...r.rejectedRunning, ...r.busy], notFound: r.notFound });
});
