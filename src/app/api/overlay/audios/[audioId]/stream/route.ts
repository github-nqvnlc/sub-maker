import { notFound, pathParam, route, type RouteContext } from '@/lib/api/errors';
import { requireUser } from '@/lib/auth/guards';
import { getOwnedOverlayAudio } from '@/lib/overlay/service';
import { serveObject } from '@/lib/storage/proxy';

export const dynamic = 'force-dynamic';

/** Phát tệp âm thanh đã tải lên qua proxy CÓ KIỂM TRA CHỦ SỞ HỮU (Nguyên tắc I), hỗ trợ `Range`. Chưa sẵn sàng → 404. */
export const GET = route(async (request: Request, ctx: RouteContext) => {
  const user = await requireUser(request);
  const audio = await getOwnedOverlayAudio(user.id, await pathParam(ctx, 'audioId'));
  if (audio.status !== 'ready' || !audio.storageKey) throw notFound();
  const res = await serveObject(audio.storageKey, { contentType: 'audio/mpeg', rangeHeader: request.headers.get('range') });
  if (res.status === 404) throw notFound();
  return res;
});
