import { conflict, notFound, pathParam, readJson, route, type RouteContext, validation } from '@/lib/api/errors';
import { z } from 'zod';
import { requireUser } from '@/lib/auth/guards';
import { projectDescriptionSchema, projectNameSchema, providerTypeSchema } from '@/lib/schemas/common';
import { deleteProjects } from '@/lib/projects/delete';
import { getProjectDetail, updateProject } from '@/lib/projects/service';

export const dynamic = 'force-dynamic';

const patchBody = z
  .object({
    name: projectNameSchema.optional(),
    description: projectDescriptionSchema.nullable().optional(),
    providerType: providerTypeSchema.optional(),
  })
  .strict();

export const GET = route(async (request: Request, ctx: RouteContext) => {
  const user = await requireUser(request);
  return Response.json(await getProjectDetail(user.id, await pathParam(ctx, 'projectId')));
});

export const PATCH = route(async (request: Request, ctx: RouteContext) => {
  const user = await requireUser(request);
  const id = await pathParam(ctx, 'projectId');
  const body = patchBody.parse(await readJson(request));
  if (Object.keys(body).length === 0) throw validation({ _: 'Không có thay đổi nào' });
  return Response.json(await updateProject(user.id, id, body));
});

/** Xóa Project và toàn bộ dữ liệu liên quan; tiến trình đang chạy được dừng trước (FR-004). */
export const DELETE = route(async (request: Request, ctx: RouteContext) => {
  const user = await requireUser(request);
  const id = await pathParam(ctx, 'projectId');
  const r = await deleteProjects(user.id, [id]);
  if (r.notFound.includes(id)) throw notFound();
  if (r.busy.includes(id)) throw conflict('CONFLICT', 'Tiến trình của Project đang dừng, hãy thử lại sau ít giây.');
  return new Response(null, { status: 204 });
});
