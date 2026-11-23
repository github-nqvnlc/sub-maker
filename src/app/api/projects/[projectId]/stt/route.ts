import { HttpError, pathParam, route, type RouteContext } from '@/lib/api/errors';
import { requireUser } from '@/lib/auth/guards';
import { createSttJob, listProjectSttJobs, MAX_VIDEO_BYTES } from '@/lib/stt/service';

export const dynamic = 'force-dynamic';

/** Danh sách STT job của Project (spec 004, US3). Project của người khác → 404. */
export const GET = route(async (request: Request, ctx: RouteContext) => {
  const user = await requireUser(request);
  return Response.json(await listProjectSttJobs(user.id, await pathParam(ctx, 'projectId')));
});

/**
 * Tạo STT job (spec 004, US1): multipart gồm `file` (audio/video) và các trường tùy chọn
 * `targetFormat` (srt|txt|md), `targetFileName`, `language` (auto|mã ngôn ngữ), `enableDiarization` (true|false).
 * Thứ tự kiểm tra: quyền Project (404) → định dạng/dung lượng (422/413) → giới hạn số job (429).
 */
export const POST = route(async (request: Request, ctx: RouteContext) => {
  const user = await requireUser(request);
  const projectId = await pathParam(ctx, 'projectId');

  // Từ chối sớm theo Content-Length (kèm dư địa cho phần header multipart) trước khi đọc nội dung
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_VIDEO_BYTES + 1024 * 1024) throw new HttpError(413, 'MEDIA_TOO_LARGE');

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    throw new HttpError(422, 'VALIDATION', undefined, { file: 'Cần gửi tệp dạng multipart.' });
  }
  const file = form.get('file');
  if (!(file instanceof File)) throw new HttpError(422, 'VALIDATION', undefined, { file: 'Thiếu tệp âm thanh hoặc video.' });

  const str = (k: string) => {
    const v = form.get(k);
    return typeof v === 'string' && v.trim() !== '' ? v : undefined;
  };
  const diar = str('enableDiarization');
  const opts = {
    ...(str('targetFormat') ? { targetFormat: str('targetFormat') } : {}),
    ...(str('targetFileName') ? { targetFileName: str('targetFileName') } : {}),
    ...(str('language') ? { language: str('language') } : {}),
    ...(diar !== undefined ? { enableDiarization: diar === 'true' || diar === '1' } : {}),
  };
  const job = await createSttJob(user, projectId, { name: file.name, size: file.size, type: file.type, stream: () => file.stream() }, opts);
  return Response.json(job, { status: 201 });
});
