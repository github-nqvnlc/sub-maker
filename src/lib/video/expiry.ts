import { and, eq, inArray, max } from 'drizzle-orm';
import type { Db } from '../db';
import { videoExports, videoJobs, videoUploads } from '../db/schema';
import { getSettings } from '../settings';

/**
 * Hạn xóa video nguồn (spec 006, data-model §5, FR-054). ĐÂY LÀ HÀM DUY NHẤT ghi `video_jobs.source_expires_at`; gọi trong cùng giao
 * dịch với mọi sự kiện làm đổi một trong các giá trị nó đọc (tạo và hoàn tất tải lên; dừng, lỗi, chạy lại, chờ duyệt; sửa cue; đổi
 * kiểu; tạo, hoàn tất, lỗi bản xuất). Việc dọn dẹp chỉ đọc cột này.
 *
 * - đã xóa hoặc bị từ chối → không còn hạn;
 * - đang tải → theo hạn của phiên tải video nguồn;
 * - đã có bản xuất thành công → lần xuất xong gần nhất + `videoSourceRetainHours`;
 * - chưa xuất lần nào → lần hoạt động gần nhất + `videoIdleRetainDays`.
 */
export async function recomputeSourceExpiry(jobId: string, tx: Db): Promise<Date | null> {
  const [job] = await tx
    .select({ sourceState: videoJobs.sourceState, lastActivityAt: videoJobs.lastActivityAt })
    .from(videoJobs)
    .where(eq(videoJobs.id, jobId))
    .for('update');
  if (!job) return null;

  let expiresAt: Date | null = null;
  if (job.sourceState === 'uploading') {
    const [open] = await tx
      .select({ expiresAt: videoUploads.expiresAt })
      .from(videoUploads)
      .where(and(eq(videoUploads.jobId, jobId), eq(videoUploads.kind, 'source'), inArray(videoUploads.state, ['active', 'completing'])));
    expiresAt = open?.expiresAt ?? null;
  } else if (job.sourceState === 'checking' || job.sourceState === 'ready') {
    const settings = await getSettings(tx);
    const [done] = await tx
      .select({ at: max(videoExports.finishedAt) })
      .from(videoExports)
      .where(and(eq(videoExports.jobId, jobId), inArray(videoExports.status, ['completed', 'expired'])));
    expiresAt = done?.at
      ? new Date(done.at.getTime() + settings.videoSourceRetainHours * 3600_000)
      : new Date(job.lastActivityAt.getTime() + settings.videoIdleRetainDays * 24 * 3600_000);
  }
  await tx.update(videoJobs).set({ sourceExpiresAt: expiresAt }).where(eq(videoJobs.id, jobId));
  return expiresAt;
}
