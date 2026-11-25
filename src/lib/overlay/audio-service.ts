import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { HttpError } from '../api/errors';
import { getDb } from '../db';
import { OVERLAY_ACTIVE_STATUSES, overlayAudios, overlayJobs, users } from '../db/schema';
import { getOwnedProject, isUuid } from '../projects/access';
import { getSettings } from '../settings';
import { purgeObjects } from '../storage/cleanup';
import { deleteObject, putObjectStream } from '../storage/client';
import { storageKeys } from '../storage/keys';
import { enqueuePrepareOverlayAudio } from '../../worker/queues';

/**
 * Tệp âm thanh người dùng tải lên cho video overlay (FR-002, FR-043, FR-044). Web chỉ nhận tệp vào vùng tạm; việc nền đo, chuyển
 * MP3 rồi mới tính hạn mức (research R10). Mọi truy cập theo chủ sở hữu (Nguyên tắc I).
 */

export const OVERLAY_AUDIO_EXTS = ['mp3', 'wav', 'm4a'] as const;
export type OverlayAudioExt = (typeof OVERLAY_AUDIO_EXTS)[number];
export const MAX_OVERLAY_AUDIO_BYTES = 100 * 1024 * 1024;
/** Số tệp đang xử lý cùng lúc của một User. */
export const MAX_PROCESSING_AUDIOS = 3;
const ADMISSION_LOCK = 727_007;
/** MP3 192 kbps. */
const STORED_BYTES_PER_SEC = 24_000;
const SNIFF_BYTES = 4096;

type AudioRow = typeof overlayAudios.$inferSelect;
export type OverlayAudioDto = {
  id: string;
  originalName: string;
  status: AudioRow['status'];
  sizeBytes: number;
  durationMs: number | null;
  errorCode: string | null;
  createdAt: string;
};

export const overlayAudioDto = (r: AudioRow): OverlayAudioDto => ({
  id: r.id,
  originalName: r.originalName,
  status: r.status,
  sizeBytes: r.sizeBytes,
  durationMs: r.durationMs,
  errorCode: r.errorCode,
  createdAt: r.createdAt.toISOString(),
});

export function overlayAudioExt(fileName: string): OverlayAudioExt | null {
  const ext = /\.([a-z0-9]+)$/i.exec(fileName.trim())?.[1]?.toLowerCase();
  return OVERLAY_AUDIO_EXTS.find((e) => e === ext) ?? null;
}

const ascii = (b: Uint8Array, at: number, n: number): string => String.fromCharCode(...b.subarray(at, at + n));

/** Phần đầu tệp có đúng dạng của đuôi không (tệp giả đuôi bị từ chối ngay; tệp hỏng do việc nền phát hiện). */
export function looksLike(ext: OverlayAudioExt, head: Uint8Array): boolean {
  if (ext === 'wav') return ['RIFF', 'RF64'].includes(ascii(head, 0, 4)) && ascii(head, 8, 4) === 'WAVE';
  if (ext === 'm4a') return ascii(head, 4, 4) === 'ftyp';
  if (ascii(head, 0, 3) === 'ID3') return true;
  for (let i = 0; i + 1 < head.length; i++) if (head[i] === 0xff && (head[i + 1]! & 0xe0) === 0xe0) return true;
  return false;
}

/** Dung lượng MP3 dự kiến sau khi chuyển: WAV tính theo tốc độ byte ghi trong tệp, còn lại coi như bằng tệp gốc. Chỉ là ước tính. */
export function expectedStoredBytes(ext: OverlayAudioExt, size: number, head: Uint8Array): number {
  if (ext !== 'wav' || head.length < 32) return size;
  const byteRate = new DataView(head.buffer, head.byteOffset, head.byteLength).getUint32(28, true);
  return byteRate > 0 ? Math.min(size, Math.ceil((size / byteRate) * STORED_BYTES_PER_SEC)) : size;
}

export type AudioUpload = { name: string; size: number; head: () => Promise<Uint8Array>; stream: () => ReadableStream<Uint8Array> };

export const audioUploadOf = (file: File): AudioUpload => ({
  name: file.name,
  size: file.size,
  head: async () => new Uint8Array(await file.slice(0, SNIFF_BYTES).arrayBuffer()),
  stream: () => file.stream(),
});

/** Thứ tự kiểm tra: quyền Project (404) → đuôi và nội dung (422) → dung lượng (413) → số tệp đang xử lý (429) → chỗ còn lại (409). */
export async function createOverlayAudio(user: { id: string }, projectId: string, file: AudioUpload): Promise<OverlayAudioDto> {
  await getOwnedProject(user.id, projectId);
  const ext = overlayAudioExt(file.name);
  if (!ext || file.size <= 0) throw new HttpError(422, 'OVERLAY_AUDIO_UNSUPPORTED');
  if (file.size > MAX_OVERLAY_AUDIO_BYTES) throw new HttpError(413, 'OVERLAY_AUDIO_TOO_LARGE');
  const head = await file.head();
  if (!looksLike(ext, head)) throw new HttpError(422, 'OVERLAY_AUDIO_UNSUPPORTED');

  const id = randomUUID();
  const tempKey = storageKeys.overlayAudioTemp(user.id, id, ext);
  const db = getDb();
  const expected = expectedStoredBytes(ext, file.size, head);
  const { userQuotaBytes } = await getSettings();
  const row = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${ADMISSION_LOCK}, hashtext(${user.id}))`);
    const [c] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(overlayAudios)
      .where(and(eq(overlayAudios.ownerId, user.id), eq(overlayAudios.status, 'processing')));
    if ((c?.n ?? 0) >= MAX_PROCESSING_AUDIOS) throw new HttpError(429, 'OVERLAY_TOO_MANY_UPLOADS');
    const [u] = await tx.select({ used: users.storageUsedBytes }).from(users).where(eq(users.id, user.id));
    const [p] = await tx
      .select({ n: sql<string>`coalesce(sum(${overlayJobs.estimatedBytes}), 0)` })
      .from(overlayJobs)
      .where(and(eq(overlayJobs.ownerId, user.id), inArray(overlayJobs.status, [...OVERLAY_ACTIVE_STATUSES])));
    const remaining = Math.max(0, userQuotaBytes - (u?.used ?? 0) - Number(p?.n ?? 0));
    if (expected > remaining) {
      throw new HttpError(409, 'QUOTA_EXCEEDED', 'Không đủ dung lượng lưu trữ cho tệp âm thanh này. Hãy xóa bớt video, tệp âm thanh hoặc voice rồi thử lại.', {
        needBytes: String(expected - remaining),
        remainingBytes: String(remaining),
        estimateBytes: String(expected),
      });
    }
    const [r] = await tx
      .insert(overlayAudios)
      .values({ id, projectId, ownerId: user.id, originalName: file.name.slice(0, 255), tempStorageKey: tempKey })
      .returning();
    return r!;
  });

  const undo = async () => {
    await db.delete(overlayAudios).where(eq(overlayAudios.id, id));
    await deleteObject(tempKey).catch(() => undefined);
  };
  try {
    await putObjectStream(tempKey, file.stream(), file.size, 'application/octet-stream');
  } catch (e) {
    await undo();
    throw e;
  }
  try {
    await enqueuePrepareOverlayAudio(id);
  } catch {
    await undo();
    throw new HttpError(503, 'INTERNAL', 'Hệ thống tạm thời chưa nhận được việc mới. Hãy thử lại sau ít phút.');
  }
  return overlayAudioDto(row);
}

export async function listOverlayAudios(ownerId: string, projectId: string): Promise<OverlayAudioDto[]> {
  await getOwnedProject(ownerId, projectId);
  const rows = await getDb()
    .select()
    .from(overlayAudios)
    .where(and(eq(overlayAudios.projectId, projectId), eq(overlayAudios.ownerId, ownerId)))
    .orderBy(desc(overlayAudios.createdAt));
  return rows.map(overlayAudioDto);
}

/** Xóa tệp âm thanh, trả lại hạn mức. Tiến trình xuất đang dùng tệp sẽ báo `SOURCE_DELETED` (khóa ngoại về null); việc nền đang xử lý tự dừng. */
export async function deleteOverlayAudios(ownerId: string, ids: string[]): Promise<{ deleted: string[]; busy: string[]; notFound: string[] }> {
  const db = getDb();
  const valid = ids.filter(isUuid);
  const gone = valid.length
    ? await db
        .delete(overlayAudios)
        .where(and(eq(overlayAudios.ownerId, ownerId), inArray(overlayAudios.id, valid)))
        .returning()
    : [];
  for (const a of gone) {
    if (a.tempStorageKey) await deleteObject(a.tempStorageKey).catch(() => undefined);
    if (a.status === 'ready' && a.storageKey) await purgeObjects(ownerId, [{ key: a.storageKey, size: a.sizeBytes }]);
    else await deleteObject(storageKeys.overlayAudio(ownerId, a.id)).catch(() => undefined);
  }
  const deleted = gone.map((a) => a.id);
  return { deleted, busy: [], notFound: ids.filter((id) => !deleted.includes(id)) };
}
