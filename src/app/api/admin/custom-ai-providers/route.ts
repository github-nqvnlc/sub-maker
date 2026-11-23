import { readJson, route } from '@/lib/api/errors';
import { requireAdmin } from '@/lib/auth/guards';
import { createCustomProvider, customProviderInputSchema, listCustomProvidersAdmin } from '@/lib/providers/custom-provider-service';

export const dynamic = 'force-dynamic';

/** Danh sách Custom Provider chuẩn OpenAI do Administrator quản lý (spec 004, US5). */
export const GET = route(async (request: Request) => {
  await requireAdmin(request);
  return Response.json(await listCustomProvidersAdmin());
});

export const POST = route(async (request: Request) => {
  await requireAdmin(request);
  const input = customProviderInputSchema.parse(await readJson(request));
  return Response.json(await createCustomProvider(input), { status: 201 });
});
