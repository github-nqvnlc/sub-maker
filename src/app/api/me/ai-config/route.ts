import { notFound, readJson, route } from '@/lib/api/errors';
import { requireUser } from '@/lib/auth/guards';
import { aiConfigInputSchema, listConfigs, upsertConfig } from '@/lib/providers/config-service';

export const dynamic = 'force-dynamic';

/** Cấu hình AI riêng: chỉ User thuộc danh sách (can_use_custom_ai); người khác nhận 404 (FR-043). */
export const GET = route(async (request: Request) => {
  const user = await requireUser(request);
  if (!user.canUseCustomAi) throw notFound();
  return Response.json(await listConfigs('user', user.id));
});

export const PUT = route(async (request: Request) => {
  const user = await requireUser(request);
  if (!user.canUseCustomAi) throw notFound();
  const input = aiConfigInputSchema.parse(await readJson(request));
  return Response.json(await upsertConfig('user', user.id, input));
});
