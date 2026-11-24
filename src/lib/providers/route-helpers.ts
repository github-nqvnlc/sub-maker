import { notFound, type RouteContext, pathParam } from '../api/errors';
import { ttsProviderTypeSchema, type TtsProviderType } from '../schemas/common';

/** Đọc `[type]` từ đường dẫn; giá trị lạ → 404. */
export async function providerTypeParam(ctx: RouteContext): Promise<TtsProviderType> {
  const parsed = ttsProviderTypeSchema.safeParse(await pathParam(ctx, 'type'));
  if (!parsed.success) throw notFound();
  return parsed.data;
}
