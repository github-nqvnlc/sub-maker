import { HttpError, notFound, route } from '@/lib/api/errors';
import { requireUser } from '@/lib/auth/guards';
import { serveObject } from '@/lib/storage/proxy';
import { headObject } from '@/lib/storage/client';
import { AVATAR_MAX_BYTES, removeAvatar, setAvatar } from '@/lib/users/service';

export const dynamic = 'force-dynamic';

export const GET = route(async (request: Request) => {
  const user = await requireUser(request);
  if (!user.avatarKey) throw notFound();
  const head = await headObject(user.avatarKey);
  if (!head) throw notFound();
  // Content-Type lấy từ nội dung thật (không tin metadata), cache riêng tư theo phiên
  const res = await serveObject(user.avatarKey, {
    contentType: head.contentType ?? 'application/octet-stream',
    rangeHeader: request.headers.get('range'),
    // Ảnh nhỏ (≤ 1 MB): luôn tải lại để đổi ảnh có hiệu lực ngay, không cho cache dùng chung
    cacheControl: 'private, no-cache',
  });
  return res;
});

export const PUT = route(async (request: Request) => {
  const user = await requireUser(request);
  const declared = Number(request.headers.get('content-length'));
  // Từ chối sớm khi Content-Length đã vượt (kèm dư địa cho phần header multipart)
  if (Number.isFinite(declared) && declared > AVATAR_MAX_BYTES + 64 * 1024) {
    throw new HttpError(413, 'FILE_TOO_LARGE', undefined, { file: 'Ảnh đại diện tối đa 1 MB' });
  }
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    throw new HttpError(422, 'VALIDATION', undefined, { file: 'Cần gửi tệp ảnh dạng multipart' });
  }
  const file = form.get('file');
  if (!(file instanceof File)) throw new HttpError(422, 'VALIDATION', undefined, { file: 'Thiếu tệp ảnh' });
  await setAvatar(user, new Uint8Array(await file.arrayBuffer()));
  return Response.json({ ok: true });
});

export const DELETE = route(async (request: Request) => {
  const user = await requireUser(request);
  await removeAvatar(user);
  return new Response(null, { status: 204 });
});
