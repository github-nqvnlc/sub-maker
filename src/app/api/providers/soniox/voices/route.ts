import { route } from '@/lib/api/errors';
import { requireUser } from '@/lib/auth/guards';
import { fetchSonioxVoices } from '@/lib/providers/soniox-voices';

export const dynamic = 'force-dynamic';

export const GET = route(async (request: Request) => {
  const user = await requireUser(request);
  const voices = await fetchSonioxVoices(user.id);
  return Response.json(voices);
});
