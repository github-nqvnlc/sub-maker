import { pathParam, route, type RouteContext } from '@/lib/api/errors';
import { requireUser } from '@/lib/auth/guards';
import { resolveSource } from '@/lib/overlay/service';

export const dynamic = 'force-dynamic';

/** Mốc áp dụng của các cue cho cặp voice và phụ đề, dùng cho khung xem trước (spec 005, FR-004). */
export const GET = route(async (request: Request, ctx: RouteContext) => {
  const user = await requireUser(request);
  const q = new URL(request.url).searchParams;
  const r = await resolveSource(user.id, await pathParam(ctx, 'projectId'), { voiceId: q.get('voiceId'), audioId: q.get('audioId'), fileId: q.get('fileId') });
  return Response.json({ durationMs: r.durationMs, cues: r.cues, warnings: r.warnings });
});
