import { z } from 'zod';
import { readJson, route } from '@/lib/api/errors';
import { requireAdmin } from '@/lib/auth/guards';
import { getSettings, updateSettings } from '@/lib/settings';

export const dynamic = 'force-dynamic';

const MB = 1024 * 1024;
/** Giới hạn hợp lý để một giá trị nhập sai không làm hỏng hệ thống; âm/0/không nguyên → 422. */
const patchSchema = z
  .object({
    maxFileBytes: z.number().int().min(1024).max(50 * MB),
    userQuotaBytes: z.number().int().min(MB).max(1024 * 1024 * MB),
    maxConcurrentJobs: z.number().int().min(1).max(50),
    maxJobsPerUser: z.number().int().min(1).max(50),
    segmentConcurrency: z.number().int().min(1).max(16),
  })
  .partial()
  .strict();

export const GET = route(async (request: Request) => {
  await requireAdmin(request);
  return Response.json(await getSettings());
});

/** Cập nhật cài đặt; có hiệu lực ngay (đọc lại mỗi lần kiểm tra ở API/worker). */
export const PUT = route(async (request: Request) => {
  const admin = await requireAdmin(request);
  const patch = patchSchema.parse(await readJson(request));
  return Response.json(await updateSettings(patch, admin.id));
});
