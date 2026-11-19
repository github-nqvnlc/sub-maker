import { notFound, type RouteContext, pathParam } from '../api/errors';
import { providerTypeSchema } from '../schemas/common';
import type { ProviderType } from './types';

/** Đọc `[type]` từ đường dẫn; giá trị lạ → 404. */
export async function providerTypeParam(ctx: RouteContext): Promise<ProviderType> {
  const parsed = providerTypeSchema.safeParse(await pathParam(ctx, 'type'));
  if (!parsed.success) throw notFound();
  return parsed.data;
}
