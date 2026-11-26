import { HttpError, pathParam, readJson, route, type RouteContext } from '@/lib/api/errors';
import { requireUser } from '@/lib/auth/guards';
import { applyCueBatch } from '@/lib/video/cues';

export const dynamic = 'force-dynamic';

/** Đủ cho 20.000 thao tác sửa chữ thông thường; chặn thân yêu cầu quá lớn trước khi đọc vào bộ nhớ. */
const MAX_BODY_BYTES = 32 * 1024 * 1024;

/** Áp dụng một lô thao tác sửa cue (contracts/subtitle-pipeline.md §3). Không cần quyền Dịch Video: sửa dữ liệu đã có. */
export const POST = route(async (request: Request, ctx: RouteContext) => {
  const user = await requireUser(request);
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) throw new HttpError(413, 'FILE_TOO_LARGE');
  return Response.json(await applyCueBatch(user.id, await pathParam(ctx, 'jobId'), await readJson(request)));
});
