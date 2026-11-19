import { randomUUID } from 'node:crypto';
import { asc, eq, sql } from 'drizzle-orm';
import { getDb } from '../db';
import { projects, segments, subtitleFiles, voiceJobs } from '../db/schema';
import { HttpError, conflict } from '../api/errors';
import { parseScript, ScriptError } from '../parsing';
import { decodeUtf8 } from '../parsing/detect';
import { getSettings } from '../settings';
import { deleteObject, getObjectBuffer, putObject } from '../storage/client';
import { storageKeys } from '../storage/keys';
import { releaseBytes, reserveBytes } from '../storage/quota';
import { getOwnedFile, getOwnedProject } from './access';
import { fileDto } from './dto';

/** Chuyển lỗi phân tích kịch bản thành lỗi API tiếng Việt (413 cho quá lớn, 422 cho còn lại). */
export function scriptErrorToHttp(e: ScriptError): HttpError {
  if (e.code === 'TOO_LARGE') return new HttpError(413, 'FILE_TOO_LARGE', e.message, { file: e.message });
  return new HttpError(422, 'VALIDATION', e.message, { file: e.message });
}

const SEGMENT_INSERT_CHUNK = 1000;

export async function uploadScript(ownerId: string, projectId: string, file: { name: string; bytes: Uint8Array }) {
  await getOwnedProject(ownerId, projectId);
  const { maxFileBytes } = await getSettings();

  let parsed;
  try {
    parsed = parseScript(file.name, file.bytes, { maxBytes: maxFileBytes });
  } catch (e) {
    if (e instanceof ScriptError) throw scriptErrorToHttp(e);
    throw e;
  }

  // Hạn mức lưu trữ (chặt): chỉ tính dung lượng file gốc ở đây
  await reserveBytes(ownerId, file.bytes.length);

  const fileId = randomUUID();
  const key = storageKeys.subtitleOriginal(ownerId, fileId);
  try {
    await putObject(key, Buffer.from(file.bytes), 'text/plain; charset=utf-8');
    await getDb().transaction(async (tx) => {
      await tx.insert(subtitleFiles).values({
        id: fileId,
        projectId,
        ownerId,
        originalName: file.name.slice(0, 255),
        ext: parsed.ext,
        sizeBytes: file.bytes.length,
        storageKey: key,
        contentHash: parsed.contentHash,
        charCount: parsed.charCount,
        segmentCount: parsed.segments.length,
      });
      for (let i = 0; i < parsed.segments.length; i += SEGMENT_INSERT_CHUNK) {
        await tx.insert(segments).values(
          parsed.segments.slice(i, i + SEGMENT_INSERT_CHUNK).map((text, j) => ({
            subtitleFileId: fileId,
            idx: i + j,
            text,
            charCount: [...text].length,
          })),
        );
      }
      await tx.update(projects).set({ updatedAt: sql`now()` }).where(eq(projects.id, projectId));
    });
  } catch (e) {
    // hoàn tác: xóa đối tượng đã lưu và trả lại dung lượng
    await deleteObject(key).catch(() => undefined);
    await releaseBytes(ownerId, file.bytes.length);
    throw e;
  }

  const [row] = await getDb().select().from(subtitleFiles).where(eq(subtitleFiles.id, fileId));
  return {
    ...fileDto(row!),
    rawText: parsed.rawText,
    segments: parsed.segments.map((text, idx) => ({ idx, text, charCount: [...text].length })),
  };
}

export async function listFiles(ownerId: string, projectId: string) {
  await getOwnedProject(ownerId, projectId);
  const rows = await getDb().select().from(subtitleFiles).where(eq(subtitleFiles.projectId, projectId)).orderBy(sql`${subtitleFiles.createdAt} desc`);
  return rows.map(fileDto);
}

/** Chi tiết file: văn bản gốc (đọc từ MinIO) và các đoạn đã tách (FR-010, FR-011). */
export async function getFileDetail(ownerId: string, fileId: string) {
  const row = await getOwnedFile(ownerId, fileId);
  const segs = await getDb()
    .select({ idx: segments.idx, text: segments.text, charCount: segments.charCount })
    .from(segments)
    .where(eq(segments.subtitleFileId, fileId))
    .orderBy(asc(segments.idx));
  let rawText = '';
  try {
    rawText = decodeUtf8(await getObjectBuffer(row.storageKey));
  } catch {
    rawText = ''; // đối tượng đã mất: vẫn trả các đoạn đã tách
  }
  return { ...fileDto(row), rawText, segments: segs };
}

/**
 * Xóa file. Bị chặn (409) nếu còn tiến trình/voice dùng file: xóa file sẽ kéo theo xóa các tiến trình
 * và voice đó nên người dùng phải xóa chúng trước một cách có chủ đích.
 */
export async function deleteFile(ownerId: string, fileId: string): Promise<void> {
  const row = await getOwnedFile(ownerId, fileId);
  const db = getDb();
  const [{ n } = { n: 0 }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(voiceJobs)
    .where(eq(voiceJobs.subtitleFileId, fileId));
  if (n > 0) {
    throw conflict('CONFLICT', `File đang được dùng bởi ${n} tiến trình/voice. Hãy xóa các tiến trình đó trước.`);
  }
  await deleteObject(row.storageKey).catch(() => undefined);
  await db.transaction(async (tx) => {
    await tx.delete(subtitleFiles).where(eq(subtitleFiles.id, fileId));
    await tx.update(projects).set({ updatedAt: sql`now()` }).where(eq(projects.id, row.projectId));
  });
  await releaseBytes(ownerId, row.sizeBytes);
}
