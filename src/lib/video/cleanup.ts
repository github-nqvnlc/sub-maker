import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { getDb } from '../db';
import { videoExports, videoJobs, videoUploads } from '../db/schema';
import { abortMultipart, deleteByPrefix, listMultipartUploads } from '../storage/client';
import { storageKeys } from '../storage/keys';
import { releaseBytes } from '../storage/quota';
import { releaseProviderData, type ProviderSnapshot } from './provider-data';
import { addVideoUsed, withVideoLock } from './quota';

/**
 * Dọn dữ liệu của dịch video khi xóa việc, Project hoặc User (spec 006, FR-057, research R13).
 * Phần dở của phiên multipart KHÔNG hiện khi liệt kê đối tượng nên phải hủy theo bản ghi CSDL.
 */
export type VideoCleanup = {
  ownerId: string;
  jobIds: string[];
  /** phiên tải chưa kết thúc: hủy theo bản ghi */
  uploads: Array<{ key: string; storageUploadId: string }>;
  /** việc còn dữ liệu ở nhà cung cấp */
  provider: ProviderSnapshot[];
  /** khóa thành phẩm của các bản xuất: có thể còn phiên multipart dở */
  exportKeys: string[];
};

type Scope = { projectId?: string; jobIds?: string[] };

const scopeOf = (ownerId: string, scope: Scope) =>
  and(
    eq(videoJobs.ownerId, ownerId),
    scope.projectId ? eq(videoJobs.projectId, scope.projectId) : undefined,
    scope.jobIds ? inArray(videoJobs.id, scope.jobIds.length ? scope.jobIds : ['00000000-0000-0000-0000-000000000000']) : undefined,
  );

/** Thu thập những gì phải dọn ngoài CSDL. Gọi TRƯỚC khi xóa bản ghi. */
export async function collectVideoCleanup(ownerId: string, scope: Scope = {}, db = getDb()): Promise<VideoCleanup> {
  const jobs = await db
    .select({
      id: videoJobs.id,
      ownerId: videoJobs.ownerId,
      projectId: videoJobs.projectId,
      translationRun: videoJobs.translationRun,
      billedRun: videoJobs.billedRun,
      model: videoJobs.model,
      sonioxFileId: videoJobs.sonioxFileId,
      sonioxTranscriptionId: videoJobs.sonioxTranscriptionId,
    })
    .from(videoJobs)
    .where(scopeOf(ownerId, scope));
  const jobIds = jobs.map((j) => j.id);
  const uploads = jobIds.length
    ? await db
        .select({ key: videoUploads.key, storageUploadId: videoUploads.storageUploadId })
        .from(videoUploads)
        .where(and(inArray(videoUploads.jobId, jobIds), inArray(videoUploads.state, ['active', 'completing'])))
    : [];
  const exports = jobIds.length
    ? await db
        .select({ id: videoExports.id, jobId: videoExports.jobId, format: videoExports.format, attempt: videoExports.attempt })
        .from(videoExports)
        .where(inArray(videoExports.jobId, jobIds))
    : [];
  return {
    ownerId,
    jobIds,
    uploads,
    provider: jobs.filter((j) => j.sonioxFileId || j.sonioxTranscriptionId),
    // lượt đang chạy và lượt trước đó (có thể bị bỏ dở)
    exportKeys: exports.flatMap((e) => [e.attempt, e.attempt - 1].filter((n) => n > 0).map((n) => storageKeys.videoExport(ownerId, e.jobId, e.id, e.format, n))),
  };
}

/** Hủy phiên multipart dở của một thành phẩm (worker chết giữa lúc đưa lên kho). Lỗi được bỏ qua: lần dọn sau làm lại. */
export async function abortExportUploads(key: string): Promise<void> {
  for (const id of await listMultipartUploads(key).catch(() => [] as string[])) await abortMultipart(key, id).catch(() => undefined);
}

/** Hủy phiên tải, xóa mọi tệp của từng việc và dữ liệu ở nhà cung cấp. Lỗi từng mục không chặn các mục khác. */
export async function runVideoCleanup(c: VideoCleanup): Promise<void> {
  for (const u of c.uploads) await abortMultipart(u.key, u.storageUploadId).catch(() => undefined);
  for (const key of c.exportKeys) await abortExportUploads(key);
  for (const jobId of c.jobIds) {
    await deleteByPrefix(storageKeys.videoJobPrefix(c.ownerId, jobId)).catch(() => undefined);
    await deleteByPrefix(storageKeys.videoJobTempPrefix(c.ownerId, jobId)).catch(() => undefined);
  }
  for (const job of c.provider) {
    if (!(await releaseProviderData(job, { jobDeleted: true }).catch(() => false))) console.warn('[video-cleanup] chưa xóa được dữ liệu ở nhà cung cấp');
  }
}

/**
 * Xóa bản ghi việc dịch và trả cả hai hạn mức (video và 500 MB của chữ phụ đề) trong MỘT giao dịch có khóa hạn mức, nên không đụng
 * với việc đang hoàn tất tải lên hay lưu thành phẩm; rồi dọn tệp.
 */
export async function deleteVideoJobs(ownerId: string, scope: Scope = {}): Promise<string[]> {
  const cleanup = await withVideoLock(async (tx) => {
    const found = await collectVideoCleanup(ownerId, scope, tx);
    if (found.jobIds.length === 0) return found;
    await tx.select({ id: videoJobs.id }).from(videoJobs).where(inArray(videoJobs.id, found.jobIds)).for('update');
    const [source] = await tx
      .select({
        video: sql<string>`coalesce(sum(case when ${videoJobs.sourceKey} is not null then ${videoJobs.fileSizeBytes} else 0 end), 0)`,
        script: sql<string>`coalesce(sum(${videoJobs.scriptBytes}), 0)`,
      })
      .from(videoJobs)
      .where(inArray(videoJobs.id, found.jobIds));
    const [outputs] = await tx
      .select({ n: sql<string>`coalesce(sum(${videoExports.outputBytes}), 0)` })
      .from(videoExports)
      .where(and(inArray(videoExports.jobId, found.jobIds), isNotNull(videoExports.outputKey)));
    await tx.delete(videoJobs).where(inArray(videoJobs.id, found.jobIds));
    await addVideoUsed(ownerId, -(Number(source?.video ?? 0) + Number(outputs?.n ?? 0)), tx);
    await releaseBytes(ownerId, Number(source?.script ?? 0), tx);
    return found;
  });
  await runVideoCleanup(cleanup);
  return cleanup.jobIds;
}
