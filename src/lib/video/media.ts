import { eq } from 'drizzle-orm';
import { HttpError, notFound, validation } from '../api/errors';
import { getDb } from '../db';
import { videoJobs } from '../db/schema';
import { serveObject } from '../storage/proxy';
import { getOwnedVideoJob } from './service';
import { VIDEO_CONTENT_TYPES } from './types';

/** Phát video nguồn, bản xem trước và âm thanh cho trình biên tập (spec 006, T060). */

export const MEDIA_KINDS = ['source', 'preview', 'audio'] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

/** Thẻ giữ lượt phát: gia hạn mỗi 60 giây khi luồng còn chạy, việc dọn dẹp không xóa tệp khi thẻ còn hạn. */
export const LEASE_MS = 5 * 60_000;
/** Dải mở (`bytes=N-`) trả tối đa chừng này; trình phát tự hỏi tiếp, nên tua trên video lớn không kéo cả tệp. */
export const MAX_OPEN_RANGE = 8 * 1024 * 1024;

export async function renewSourceLease(jobId: string): Promise<void> {
  await getDb()
    .update(videoJobs)
    .set({ sourceLeaseUntil: new Date(Date.now() + LEASE_MS) })
    .where(eq(videoJobs.id, jobId));
}

export async function serveVideoMedia(ownerId: string, jobId: string, kind: string | null, request: Request): Promise<Response> {
  const job = await getOwnedVideoJob(ownerId, jobId);
  if (!(MEDIA_KINDS as readonly string[]).includes(kind ?? '')) throw validation({ kind: 'Loại tệp phát không hợp lệ' });

  let key: string | null;
  let contentType: string;
  if (kind === 'source') {
    if (job.sourceState === 'uploading') throw new HttpError(409, 'VIDEO_SOURCE_NOT_READY');
    if (job.sourceState === 'deleted' || job.sourceState === 'rejected' || !job.sourceKey) throw new HttpError(409, 'VIDEO_SOURCE_GONE');
    [key, contentType] = [job.sourceKey, VIDEO_CONTENT_TYPES[job.ext]];
  } else if (kind === 'preview') {
    [key, contentType] = [job.previewState === 'ready' ? job.previewKey : null, 'video/mp4'];
  } else {
    [key, contentType] = [job.audioTempKey, 'audio/mpeg'];
  }
  if (!key) throw notFound();

  return serveObject(key, {
    contentType,
    rangeHeader: request.headers.get('range'),
    signal: request.signal,
    maxOpenRange: MAX_OPEN_RANGE,
    onStreaming: () => renewSourceLease(job.id),
  });
}
