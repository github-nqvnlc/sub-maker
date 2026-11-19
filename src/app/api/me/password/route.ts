import { APIError } from 'better-auth/api';
import { z } from 'zod';
import { HttpError, readJson, route } from '@/lib/api/errors';
import { getAuth } from '@/lib/auth/auth';
import { requireUser } from '@/lib/auth/guards';
import { passwordSchema } from '@/lib/schemas/common';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({ currentPassword: z.string().min(1), newPassword: passwordSchema }).strict();

export const POST = route(async (request: Request) => {
  await requireUser(request);
  const body = bodySchema.parse(await readJson(request));
  try {
    await getAuth().api.changePassword({
      body: { currentPassword: body.currentPassword, newPassword: body.newPassword, revokeOtherSessions: true },
      headers: request.headers,
    });
  } catch (e) {
    if (e instanceof APIError) {
      // Sai mật khẩu hiện tại → lỗi trên đúng trường, không lộ chi tiết khác
      throw new HttpError(422, 'VALIDATION', undefined, { currentPassword: 'Mật khẩu hiện tại không đúng' });
    }
    throw e;
  }
  return new Response(null, { status: 204 });
});
