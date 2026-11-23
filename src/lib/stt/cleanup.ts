import { and, eq, isNotNull, or } from 'drizzle-orm';
import { getDb } from '../db';
import { sttJobs } from '../db/schema';
import { deleteObject } from '../storage/client';
import { getSttConfigRow, sonioxClientFor } from './config';

/**
 * Dọn dữ liệu của STT job (spec 004, FR-021): file media tạm trên MinIO và file/bản phiên âm trên Soniox.
 * Lỗi khi dọn KHÔNG làm job hay thao tác xóa thất bại: hàm trả `false` để người gọi ghi cảnh báo.
 */

export type SonioxIds = { fileId?: string | null; transcriptionId?: string | null };

/** Xóa bản phiên âm rồi file trên Soniox (theo thứ tự tài liệu: file phải còn đến khi transcription kết thúc). */
export async function deleteSonioxData(ids: SonioxIds): Promise<boolean> {
  if (!ids.fileId && !ids.transcriptionId) return true;
  const cfg = await getSttConfigRow().catch(() => null);
  if (!cfg) return false;
  const { client } = sonioxClientFor(cfg);
  let ok = true;
  if (ids.transcriptionId) {
    try {
      await client.deleteTranscription(ids.transcriptionId);
    } catch {
      ok = false;
    }
  }
  if (ids.fileId) {
    try {
      await client.deleteFile(ids.fileId);
    } catch {
      ok = false;
    }
  }
  return ok;
}

export async function deleteTempMedia(key: string | null | undefined): Promise<boolean> {
  if (!key) return true;
  try {
    await deleteObject(key);
    return true;
  } catch {
    return false;
  }
}

/** Thu thập dữ liệu cần dọn của các STT job (gọi TRƯỚC khi xóa bản ghi Project/User). */
export async function collectSttCleanup(where: { projectId?: string; ownerId?: string }) {
  const conds = [];
  if (where.projectId) conds.push(eq(sttJobs.projectId, where.projectId));
  if (where.ownerId) conds.push(eq(sttJobs.ownerId, where.ownerId));
  if (conds.length === 0) return [];
  return getDb()
    .select({ key: sttJobs.tempStorageKey, fileId: sttJobs.sonioxFileId, transcriptionId: sttJobs.sonioxTranscriptionId })
    .from(sttJobs)
    .where(and(...conds, or(isNotNull(sttJobs.tempStorageKey), isNotNull(sttJobs.sonioxFileId), isNotNull(sttJobs.sonioxTranscriptionId))));
}

/** Dọn theo danh sách đã thu thập; trả số mục dọn lỗi (chỉ để ghi log). */
export async function runSttCleanup(items: Array<{ key: string | null; fileId: string | null; transcriptionId: string | null }>): Promise<number> {
  let failed = 0;
  for (const it of items) {
    if (!(await deleteTempMedia(it.key))) failed++;
    if (!(await deleteSonioxData({ fileId: it.fileId, transcriptionId: it.transcriptionId }))) failed++;
  }
  if (failed > 0) console.warn(`[stt-cleanup] ${failed} mục dọn dẹp không thành công (sẽ không ảnh hưởng dữ liệu người dùng)`);
  return failed;
}

