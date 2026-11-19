import { route } from '@/lib/api/errors';
import { requireUser } from '@/lib/auth/guards';
import { allCatalogs } from '@/lib/providers/catalog';
import { availabilityFor } from '@/lib/providers/config-service';

export const dynamic = 'force-dynamic';

/** Danh mục loại nhà cung cấp, model, giọng, thang tốc độ + khả dụng cho User hiện tại. */
export const GET = route(async (request: Request) => {
  const user = await requireUser(request);
  const availability = await availabilityFor(user);
  return Response.json(
    allCatalogs().map((c) => ({
      type: c.type,
      label: c.label,
      available: availability[c.type].available,
      usingOwnConfig: availability[c.type].usingOwnConfig,
      models: c.models.map((m) => ({ id: m.id, voices: m.voices })),
      speed: c.speed,
      maxCharsPerRequest: c.maxCharsPerRequest,
    })),
  );
});
