import { pathParam, route, type RouteContext } from '@/lib/api/errors';
import { requireUser } from '@/lib/auth/guards';
import { downloadSubtitles } from '@/lib/video/subtitle-service';

export const dynamic = 'force-dynamic';

/** `?format=srt|vtt&content=target|source|bilingual`: tệp phụ đề theo kịch bản mới nhất (FR-039). */
export const GET = route(async (request: Request, ctx: RouteContext) => {
  const user = await requireUser(request);
  return downloadSubtitles(user.id, await pathParam(ctx, 'jobId'), new URL(request.url).searchParams);
});
