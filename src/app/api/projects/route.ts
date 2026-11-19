import { z } from 'zod';
import { readJson, route } from '@/lib/api/errors';
import { requireUser } from '@/lib/auth/guards';
import { paginationSchema, projectDescriptionSchema, projectNameSchema, providerTypeSchema } from '@/lib/schemas/common';
import { createProject, listProjects } from '@/lib/projects/service';

export const dynamic = 'force-dynamic';

const listQuery = paginationSchema.extend({
  q: z.string().max(200).optional(),
  sort: z.enum(['name', 'createdAt', 'updatedAt', 'voiceCount']).default('updatedAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
  provider: providerTypeSchema.optional(),
  jobState: z.enum(['running', 'failed', 'none']).optional(),
});

const createBody = z
  .object({
    name: projectNameSchema,
    description: projectDescriptionSchema.nullable().optional(),
    providerType: providerTypeSchema,
  })
  .strict();

/** Danh sách Project của tôi: tìm kiếm không dấu, sắp xếp, lọc, phân trang (FR-005..008). */
export const GET = route(async (request: Request) => {
  const user = await requireUser(request);
  const q = listQuery.parse(Object.fromEntries(new URL(request.url).searchParams));
  return Response.json(await listProjects(user.id, q));
});

export const POST = route(async (request: Request) => {
  const user = await requireUser(request);
  const body = createBody.parse(await readJson(request));
  return Response.json(await createProject(user.id, body), { status: 201 });
});
