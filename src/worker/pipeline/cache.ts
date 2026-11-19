import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { getDb } from '../../lib/db';
import { audioCache } from '../../lib/db/schema';
import { pcmDurationMs, pcmToWav, wavToPcm } from '../../lib/audio/ffmpeg';
import type { ProviderType } from '../../lib/schemas/common';
import { deleteObject, getObjectBuffer, putObject } from '../../lib/storage/client';
import { storageKeys } from '../../lib/storage/keys';
import { releaseBytes, reserveBytes } from '../../lib/storage/quota';

/**
 * Cache audio TỪNG ĐOẠN, THEO USER và theo nội dung (research R7, FR-017, Nguyên tắc IV):
 *   hash = sha256(userId | providerType | model | voice | speed | định dạng | văn bản NFC)
 * Cache không dùng chung giữa các User để không lộ việc ai đã sinh nội dung nào và để chi phí không bị tính lẫn.
 * Cấu hình chung/riêng KHÔNG nằm trong hash vì âm thanh theo (model, voice, speed) là như nhau.
 */

export type CacheKeyInput = {
  userId: string;
  providerType: ProviderType;
  model: string | null;
  voice: string;
  speed: number | null;
  text: string;
};

const FORMAT = 'pcm24k-mono-s16';

export function contentHash(i: CacheKeyInput): string {
  return createHash('sha256')
    .update([i.userId, i.providerType, i.model ?? '', i.voice, i.speed ?? 'default', FORMAT, i.text.normalize('NFC')].join('\u0000'), 'utf8')
    .digest('hex');
}

export type CachedAudio = { id: string; pcm: Buffer; durationMs: number };

/** Tìm trong cache; nếu bản ghi còn nhưng đối tượng MinIO đã mất thì dọn bản ghi và coi như chưa có. */
export async function loadCached(ownerId: string, hash: string): Promise<CachedAudio | null> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(audioCache)
    .where(and(eq(audioCache.ownerId, ownerId), eq(audioCache.contentHash, hash)))
    .limit(1);
  if (!row) return null;
  try {
    const pcm = wavToPcm(await getObjectBuffer(row.storageKey));
    await db.update(audioCache).set({ lastUsedAt: new Date() }).where(eq(audioCache.id, row.id));
    return { id: row.id, pcm, durationMs: row.durationMs };
  } catch {
    await db.delete(audioCache).where(eq(audioCache.id, row.id));
    await releaseBytes(ownerId, row.sizeBytes);
    return null;
  }
}

/** Đọc lại PCM của một mục cache đã biết id (dùng khi ghép). */
export async function loadCachedById(ownerId: string, id: string): Promise<CachedAudio | null> {
  const [row] = await getDb()
    .select()
    .from(audioCache)
    .where(and(eq(audioCache.ownerId, ownerId), eq(audioCache.id, id)))
    .limit(1);
  if (!row) return null;
  try {
    return { id: row.id, pcm: wavToPcm(await getObjectBuffer(row.storageKey)), durationMs: row.durationMs };
  } catch {
    return null;
  }
}

export async function storeCached(
  i: CacheKeyInput & { chars: number },
  hash: string,
  pcm: Buffer,
): Promise<CachedAudio> {
  const db = getDb();
  const key = storageKeys.audioCache(i.userId, hash);
  const wav = pcmToWav(pcm);
  const durationMs = pcmDurationMs(pcm);
  await putObject(key, wav, 'audio/wav');

  const inserted = await db
    .insert(audioCache)
    .values({
      ownerId: i.userId,
      contentHash: hash,
      storageKey: key,
      durationMs,
      sizeBytes: wav.length,
      chars: i.chars,
      providerType: i.providerType,
      model: i.model,
      voice: i.voice,
      speed: i.speed,
    })
    .onConflictDoNothing({ target: [audioCache.ownerId, audioCache.contentHash] })
    .returning({ id: audioCache.id });

  if (inserted.length > 0) {
    // Chế độ MỀM: job đang chạy không bao giờ bị hủy vì vượt hạn mức (data-model, edge case)
    await reserveBytes(i.userId, wav.length, { soft: true });
    return { id: inserted[0]!.id, pcm, durationMs };
  }
  // Job khác vừa ghi cùng nội dung: dùng bản đã có
  const [existing] = await db
    .select({ id: audioCache.id })
    .from(audioCache)
    .where(and(eq(audioCache.ownerId, i.userId), eq(audioCache.contentHash, hash)))
    .limit(1);
  return { id: existing!.id, pcm, durationMs };
}

/** Xóa các mục cache không còn được `job_segments` nào tham chiếu (dùng khi xóa job/Project). */
export async function deleteCacheEntry(ownerId: string, id: string): Promise<void> {
  const [row] = await getDb()
    .delete(audioCache)
    .where(and(eq(audioCache.ownerId, ownerId), eq(audioCache.id, id)))
    .returning();
  if (!row) return;
  await deleteObject(row.storageKey).catch(() => undefined);
  await releaseBytes(ownerId, row.sizeBytes);
}
