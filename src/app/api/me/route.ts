import { z } from 'zod';
import { readJson, route } from '@/lib/api/errors';
import { getDb } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { requireUser, type AuthUser } from '@/lib/auth/guards';
import { bioSchema, displayNameSchema } from '@/lib/schemas/common';
import { toMe, updateProfile } from '@/lib/users/service';

export const dynamic = 'force-dynamic';

const patchSchema = z
  .object({
    displayName: displayNameSchema.optional(),
    bio: bioSchema.nullable().optional(),
    locale: z.enum(['vi', 'en']).optional(),
    theme: z.enum(['light', 'dark', 'system']).optional(),
  })
  .strict();

export const GET = route(async (request: Request) => {
  const user = await requireUser(request);
  return Response.json(await toMe(user));
});

export const PATCH = route(async (request: Request) => {
  const user = await requireUser(request);
  const body = patchSchema.parse(await readJson(request));
  await updateProfile(user.id, body);
  const [row] = await getDb().select().from(users).where(eq(users.id, user.id));
  const fresh: AuthUser = {
    ...user,
    name: row!.name,
    bio: row!.bio,
    locale: row!.locale === 'en' ? 'en' : 'vi',
    theme: row!.theme === 'light' || row!.theme === 'dark' ? row!.theme : 'system',
  };
  return Response.json(await toMe(fresh));
});
