import { and, eq } from 'drizzle-orm';
import { getDb } from '../db';
import { projects, subtitleFiles, voiceJobs, voices } from '../db/schema';
import { notFound } from '../api/errors';

/**
 * Truy cập tài nguyên CÓ PHẠM VI THEO CHỦ SỞ HỮU (Nguyên tắc I): mọi truy vấn theo id đều kèm `owner_id`
 * lấy từ phiên. Tài nguyên của người khác, id sai định dạng hay không tồn tại đều trả 404 như nhau.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (v: string): boolean => UUID_RE.test(v);

function assertUuid(id: string): void {
  if (!isUuid(id)) throw notFound();
}

export async function getOwnedProject(ownerId: string, id: string) {
  assertUuid(id);
  const [row] = await getDb()
    .select()
    .from(projects)
    .where(and(eq(projects.id, id), eq(projects.ownerId, ownerId)))
    .limit(1);
  if (!row) throw notFound();
  return row;
}

export async function getOwnedFile(ownerId: string, id: string) {
  assertUuid(id);
  const [row] = await getDb()
    .select()
    .from(subtitleFiles)
    .where(and(eq(subtitleFiles.id, id), eq(subtitleFiles.ownerId, ownerId)))
    .limit(1);
  if (!row) throw notFound();
  return row;
}

export async function getOwnedJob(ownerId: string, id: string) {
  assertUuid(id);
  const [row] = await getDb()
    .select()
    .from(voiceJobs)
    .where(and(eq(voiceJobs.id, id), eq(voiceJobs.ownerId, ownerId)))
    .limit(1);
  if (!row) throw notFound();
  return row;
}

export async function getOwnedVoice(ownerId: string, id: string) {
  assertUuid(id);
  const [row] = await getDb()
    .select()
    .from(voices)
    .where(and(eq(voices.id, id), eq(voices.ownerId, ownerId)))
    .limit(1);
  if (!row) throw notFound();
  return row;
}
