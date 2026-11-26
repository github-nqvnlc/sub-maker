import type { vi } from '../i18n/vi';
import type { VideoExportStatus, VideoJobStatus } from '../db/schema/video';
import type { SourceState, VideoMedia } from './types';

/**
 * Trạng thái hiển thị của một việc dịch video (spec 006, FR-048, data-model §3.2): suy ra từ pipeline dịch và các bản xuất. Dùng
 * chung cho máy chủ và giao diện.
 */
export type VideoDisplayStatus = keyof typeof vi.video.status;

type JobState = { status: VideoJobStatus; sourceState: SourceState };
/** Các bản xuất của việc, MỚI NHẤT TRƯỚC. */
type ExportState = ReadonlyArray<{ status: VideoExportStatus }>;

export function videoDisplayStatus(job: JobState, exports: ExportState = []): VideoDisplayStatus {
  // video không đạt sau khi đã dịch ở luồng nhanh (FR-003): lỗi, phụ đề vẫn tải được
  if (job.sourceState === 'rejected') return 'failed';
  const has = (s: VideoExportStatus) => exports.some((e) => e.status === s);
  if (has('running')) return 'exporting';
  if (has('queued')) return 'queued';
  if (has('interrupted')) return 'interrupted';
  switch (job.status) {
    case 'queued':
      return 'queued';
    case 'preparing':
      return 'preparing';
    case 'translating':
    case 'segmenting':
      return 'translating';
    case 'failed':
    case 'stopped':
    case 'interrupted':
      return job.status;
    case 'waiting_media':
      return 'waiting_media';
    default: {
      const last = exports[0]?.status;
      if (last === 'completed') return 'completed';
      if (last === 'failed' || last === 'stopped') return last;
      return 'review_ready';
    }
  }
}

/** Đang có việc chạy hoặc chờ chạy ở máy chủ: giao diện cần hỏi lại định kỳ. */
export const isBusyStatus = (s: VideoDisplayStatus): boolean => s === 'queued' || s === 'preparing' || s === 'translating' || s === 'exporting' || s === 'interrupted';

/** Sửa phụ đề được khi đã có kịch bản và không có lượt dịch đang chờ hoặc đang chạy (lượt đó sẽ thay toàn bộ cue). */
export const cuesEditable = (job: { status: VideoJobStatus; cueRun: number }): boolean => job.cueRun > 0 && (job.status === 'review_ready' || job.status === 'failed' || job.status === 'stopped');

/** Nguồn cần bản xem trước khi trình duyệt không phát được phổ biến, lớn hơn 1080p hoặc trên 8 Mbps (research R11). */
export const needsPreview = (m: Pick<VideoMedia, 'browserPlayable' | 'width' | 'height' | 'videoBitrate'>): boolean =>
  !m.browserPlayable || Math.min(m.width, m.height) > 1080 || m.videoBitrate > 8_000_000;
