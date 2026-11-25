import { readJson, route } from '@/lib/api/errors';
import { requireUser } from '@/lib/auth/guards';
import { deleteOverlayAudios } from '@/lib/overlay/audio-service';
import { idsBodySchema } from '@/lib/schemas/common';

export const dynamic = 'force-dynamic';

const body = idsBodySchema.strict();

/** Xóa một hoặc nhiều tệp âm thanh, trả lại hạn mức (spec 005, FR-042, FR-043). */
export const POST = route(async (request: Request) => {
  const user = await requireUser(request);
  const { ids } = body.parse(await readJson(request));
  return Response.json(await deleteOverlayAudios(user.id, [...new Set(ids)]));
});
