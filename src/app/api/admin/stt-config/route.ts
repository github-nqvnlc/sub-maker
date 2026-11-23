import { notFound, readJson, route } from '@/lib/api/errors';
import { requireAdmin } from '@/lib/auth/guards';
import { deleteSttConfig, getSttConfig, sttConfigInputSchema, upsertSttConfig } from '@/lib/stt/config';

export const dynamic = 'force-dynamic';

/** Cấu hình Soniox dùng chung (spec 004, US4): một token cho mọi model STT. `null` khi chưa cấu hình. */
export const GET = route(async (request: Request) => {
  await requireAdmin(request);
  return Response.json(await getSttConfig());
});

/** Tạo/sửa cấu hình; `apiKey` trống khi sửa = giữ khóa cũ. Model real-time bị từ chối (FR-010). */
export const PUT = route(async (request: Request) => {
  await requireAdmin(request);
  const input = sttConfigInputSchema.parse(await readJson(request));
  return Response.json(await upsertSttConfig(input));
});

export const DELETE = route(async (request: Request) => {
  await requireAdmin(request);
  if (!(await deleteSttConfig())) throw notFound();
  return new Response(null, { status: 204 });
});
