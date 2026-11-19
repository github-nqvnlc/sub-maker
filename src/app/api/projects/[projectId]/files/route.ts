import { HttpError, pathParam, route, type RouteContext } from '@/lib/api/errors';
import { requireUser } from '@/lib/auth/guards';
import { getSettings } from '@/lib/settings';
import { listFiles, uploadScript } from '@/lib/projects/files';

export const dynamic = 'force-dynamic';

export const GET = route(async (request: Request, ctx: RouteContext) => {
  const user = await requireUser(request);
  return Response.json(await listFiles(user.id, await pathParam(ctx, 'projectId')));
});

/** Upload .txt/.md/.skt (FR-009); trả các đoạn đã tách để xem trước (FR-011). */
export const POST = route(async (request: Request, ctx: RouteContext) => {
  const user = await requireUser(request);
  const projectId = await pathParam(ctx, 'projectId');
  const { maxFileBytes } = await getSettings();

  // Từ chối sớm theo Content-Length (kèm dư địa cho phần header multipart) trước khi đọc toàn bộ nội dung
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxFileBytes + 64 * 1024) {
    throw new HttpError(413, 'FILE_TOO_LARGE', undefined, { file: 'Tệp vượt quá kích thước cho phép.' });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    throw new HttpError(422, 'VALIDATION', undefined, { file: 'Cần gửi tệp dạng multipart.' });
  }
  const file = form.get('file');
  if (!(file instanceof File)) throw new HttpError(422, 'VALIDATION', undefined, { file: 'Thiếu tệp kịch bản.' });

  const result = await uploadScript(user.id, projectId, { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) });
  return Response.json(result, { status: 201 });
});
