import { route } from '@/lib/api/errors';
import { requireAdmin } from '@/lib/auth/guards';
import { testSttConfig } from '@/lib/stt/config';

export const dynamic = 'force-dynamic';

/** Kiểm tra kết nối Soniox (GET /v1/models) bằng token đã lưu. */
export const POST = route(async (request: Request) => {
  await requireAdmin(request);
  return Response.json(await testSttConfig());
});
