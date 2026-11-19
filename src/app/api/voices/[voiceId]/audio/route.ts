import { notFound, pathParam, route, type RouteContext } from '@/lib/api/errors';
import { requireUser } from '@/lib/auth/guards';
import { getOwnedVoice } from '@/lib/projects/access';
import { serveObject } from '@/lib/storage/proxy';

export const dynamic = 'force-dynamic';

/**
 * Phát/tải audio qua proxy CÓ KIỂM TRA CHỦ SỞ HỮU (MinIO không mở ra ngoài, Nguyên tắc I).
 * Hỗ trợ `Range` để tua chính xác (FR-026); `?download=true` trả kèm Content-Disposition (FR-029).
 */
export const GET = route(async (request: Request, ctx: RouteContext) => {
  const user = await requireUser(request);
  const voice = await getOwnedVoice(user.id, await pathParam(ctx, 'voiceId'));
  const download = new URL(request.url).searchParams.get('download') === 'true';
  const res = await serveObject(voice.storageKey, {
    contentType: 'audio/mpeg',
    downloadName: download ? `${voice.title.replace(/[\\/:*?"<>|]+/g, '_')}.mp3` : undefined,
    rangeHeader: request.headers.get('range'),
  });
  if (res.status === 404) throw notFound(); // đối tượng audio không còn
  return res;
});
