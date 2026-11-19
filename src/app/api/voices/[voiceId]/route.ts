import { pathParam, route, type RouteContext } from '@/lib/api/errors';
import { requireUser } from '@/lib/auth/guards';
import { getVoiceDetail } from '@/lib/voices/service';

export const dynamic = 'force-dynamic';

/** Thông tin voice + mốc thời gian + văn bản từng đoạn để đồng bộ highlight. */
export const GET = route(async (request: Request, ctx: RouteContext) => {
  const user = await requireUser(request);
  return Response.json(await getVoiceDetail(user.id, await pathParam(ctx, 'voiceId')));
});
