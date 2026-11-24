import { route } from '@/lib/api/errors';
import { requireUser } from '@/lib/auth/guards';
import { allCatalogs } from '@/lib/providers/catalog';
import { availabilityFor } from '@/lib/providers/config-service';
import { listCustomProvidersForUser } from '@/lib/providers/custom-provider-service';
import { getSttConfig } from '@/lib/stt/config';

export const dynamic = 'force-dynamic';

/** Danh mục loại nhà cung cấp, model, giọng, thang tốc độ + khả dụng cho User hiện tại. */
export const GET = route(async (request: Request) => {
  const user = await requireUser(request);
  const availability = await availabilityFor(user);
  const stt = await getSttConfig().catch(() => null);
  // Spec 004: nhà cung cấp chuẩn OpenAI dùng chung nằm ở Custom Provider (có phân quyền theo User)
  const custom = await listCustomProvidersForUser({ id: user.id, role: user.role });
  return Response.json(
    allCatalogs().map((c) => ({
      type: c.type,
      label: c.label,
      available:
        c.type === 'soniox'
          ? !!stt?.enabled
          : availability[c.type]?.available || (c.type === 'openai_compatible' && custom.length > 0),
      usingOwnConfig: c.type === 'soniox' ? false : availability[c.type]?.usingOwnConfig ?? false,
      models: c.models.map((m) => ({ id: m.id, label: m.label, voices: m.voices })),
      speed: c.speed,
      maxCharsPerRequest: c.maxCharsPerRequest,
      ...(c.type === 'openai_compatible' ? { customProviders: custom } : {}),
    })),
  );
});
