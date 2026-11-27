import { HttpError, pathParam, route, type RouteContext } from '@/lib/api/errors';
import { requireUser } from '@/lib/auth/guards';
import { estimateExport } from '@/lib/video/exports';

export const dynamic = 'force-dynamic';

/** Dung lượng, thời gian ước tính, cảnh báo và lý do chưa xuất được (FR-041..FR-043). */
export const POST = route(async (request: Request, ctx: RouteContext) => {
  const user = await requireUser(request);
  const text = await request.text();
  let raw: unknown = {};
  if (text.trim()) {
    try {
      raw = JSON.parse(text);
    } catch {
      throw new HttpError(400, 'VALIDATION');
    }
  }
  return Response.json(await estimateExport(user, await pathParam(ctx, 'jobId'), raw));
});
