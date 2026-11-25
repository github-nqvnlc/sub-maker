import { HttpError, pathParam, route, type RouteContext } from '@/lib/api/errors';
import { requireUser } from '@/lib/auth/guards';
import { audioUploadOf, createOverlayAudio, listOverlayAudios, MAX_OVERLAY_AUDIO_BYTES } from '@/lib/overlay/audio-service';

export const dynamic = 'force-dynamic';

/** Tệp âm thanh đã tải lên của Project, mới nhất trước (spec 005, US5). Project của người khác → 404. */
export const GET = route(async (request: Request, ctx: RouteContext) => {
  const user = await requireUser(request);
  return Response.json(await listOverlayAudios(user.id, await pathParam(ctx, 'projectId')));
});

/** Tải lên một tệp .mp3/.wav/.m4a (multipart, trường `file`); việc chuyển MP3 chạy nền nên trả 202. */
export const POST = route(async (request: Request, ctx: RouteContext) => {
  const user = await requireUser(request);
  const projectId = await pathParam(ctx, 'projectId');
  // Từ chối sớm theo Content-Length (kèm dư địa cho phần header multipart) trước khi đọc nội dung
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_OVERLAY_AUDIO_BYTES + 1024 * 1024) throw new HttpError(413, 'OVERLAY_AUDIO_TOO_LARGE');
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    throw new HttpError(422, 'VALIDATION', undefined, { file: 'Cần gửi tệp dạng multipart.' });
  }
  const file = form.get('file');
  if (!(file instanceof File)) throw new HttpError(422, 'VALIDATION', undefined, { file: 'Thiếu tệp âm thanh.' });
  return Response.json(await createOverlayAudio(user, projectId, audioUploadOf(file)), { status: 202 });
});
