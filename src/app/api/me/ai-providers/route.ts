import { route } from '@/lib/api/errors';
import { requireUser } from '@/lib/auth/guards';
import { listCustomProvidersForUser } from '@/lib/providers/custom-provider-service';

export const dynamic = 'force-dynamic';

/**
 * Custom Provider mà User hiện tại được dùng để tạo voice (spec 004, FR-014): đang bật và `public`,
 * hoặc `restricted` có User trong danh sách. Không trả khóa, địa chỉ hay danh sách User. Không dùng cho STT.
 */
export const GET = route(async (request: Request) => {
  const user = await requireUser(request);
  return Response.json(await listCustomProvidersForUser({ id: user.id, role: user.role }));
});
