import { readJson, route } from '@/lib/api/errors';
import { requireAdmin } from '@/lib/auth/guards';
import { aiConfigInputSchema, listConfigs, upsertConfig } from '@/lib/providers/config-service';

export const dynamic = 'force-dynamic';

export const GET = route(async (request: Request) => {
  await requireAdmin(request);
  return Response.json(await listConfigs('global', null));
});

/** Tạo/sửa cấu hình chung theo `type`; `apiKey` trống khi sửa = giữ khóa cũ (FR-041). */
export const PUT = route(async (request: Request) => {
  await requireAdmin(request);
  const input = aiConfigInputSchema.parse(await readJson(request));
  return Response.json(await upsertConfig('global', null, input));
});
