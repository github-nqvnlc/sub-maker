import { stat, rm } from 'node:fs/promises';
import path from 'node:path';
import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import { demuxerOf } from '../../lib/audio/ffmpeg';
import { getDb } from '../../lib/db';
import { videoJobs } from '../../lib/db/schema';
import { getSettings } from '../../lib/settings';
import { deleteObject, downloadObjectToFile, uploadFileMultipart } from '../../lib/storage/client';
import { storageKeys } from '../../lib/storage/keys';
import { appendVideoLog } from '../../lib/video/log';
import { userMayTranslate } from '../../lib/video/permission';
import { videoSystemBytes, withVideoLock } from '../../lib/video/quota';
import type { VideoMedia } from '../../lib/video/types';
import type { RetryPolicy } from '../pipeline/synthesize-segment';
import { QUEUES, type VideoPreviewPayload } from '../queues';
import {
  defaultFreeBytes,
  JobGone,
  JobStopped,
  makeVideoTempDir,
  RunControl,
  runTrackedFfmpeg,
  startBeat,
  storageFailure,
  VIDEO_RETRY,
  VideoFailure,
  videoThreads,
  withTransientRetry,
} from '../video/run';

/**
 * Bản xem trước nhẹ cho trình biên tập (spec 006, research R11, contracts/render-and-media.md §4): 720p cạnh ngắn, H.264 CRF 28,
 * khung khóa mỗi 2 giây, AAC 96 kbps. Chạy song song với pipeline dịch, có nhịp tim và số lần chạy riêng; hỏng thì vẫn sửa, nghe tiếng
 * và xuất được.
 */
export type VideoPreviewOptions = {
  retry?: Partial<RetryPolicy>;
  heartbeatMs?: number;
  stallMs?: number;
  freeBytes?: (dir: string) => Promise<number>;
  download?: (key: string, file: string) => Promise<void>;
};

export const PREVIEW_SHORT_SIDE = 720;
const STALE_MS = 30_000;
const DISK_MARGIN = 1024 ** 3;

type Job = typeof videoJobs.$inferSelect;

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/** Kích thước bản xem trước: cạnh ngắn tối đa 720, giữ tỉ lệ hiển thị, hai cạnh chẵn. */
export function previewSize(media: Pick<VideoMedia, 'width' | 'height'>): { width: number; height: number } {
  const scale = Math.min(1, PREVIEW_SHORT_SIDE / Math.min(media.width, media.height));
  return { width: even(media.width * scale), height: even(media.height * scale) };
}

/** Tham số ffmpeg cố định (không có chữ do người dùng nhập). */
export function previewArgs(source: string, output: string, media: VideoMedia, ext: Job['ext']): string[] {
  const { width, height } = previewSize(media);
  const threads = String(videoThreads());
  return [
    '-threads', threads,
    '-protocol_whitelist', 'file',
    '-f', demuxerOf(ext),
    '-i', source,
    '-map', '0:v:0',
    '-map', `0:${media.audioIndex}`,
    '-vf', `scale=${width}:${height},setsar=1,format=yuv420p`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28',
    '-force_key_frames', 'expr:gte(t,n_forced*2)',
    '-af', 'aresample=async=1:first_pts=0',
    '-c:a', 'aac', '-b:a', '96k', '-ac', '2',
    '-movflags', '+faststart', '-map_metadata', '-1',
    '-threads', threads,
    '-y', output,
  ];
}

async function claim(jobId: string): Promise<Job | null> {
  const [row] = await getDb()
    .update(videoJobs)
    .set({ previewAttempt: sql`${videoJobs.previewAttempt} + 1`, previewHeartbeatAt: sql`now()` })
    .where(
      and(
        eq(videoJobs.id, jobId),
        eq(videoJobs.previewState, 'pending'),
        eq(videoJobs.sourceState, 'ready'),
        or(isNull(videoJobs.previewHeartbeatAt), lt(videoJobs.previewHeartbeatAt, sql`now() - (${STALE_MS} * interval '1 millisecond')`)),
      ),
    )
    .returning();
  return row ?? null;
}

export async function runVideoPreview(jobId: string, opts: VideoPreviewOptions = {}): Promise<void> {
  const job = await claim(jobId);
  if (!job) return;
  const db = getDb();
  const control = new RunControl();
  const mine = and(eq(videoJobs.id, job.id), eq(videoJobs.previewState, 'pending'), eq(videoJobs.previewAttempt, job.previewAttempt));

  // video tải lại cho việc đã dừng từ trước vẫn tạo bản xem trước; chỉ yêu cầu dừng đến trong lượt này mới làm dừng
  const stoppedBefore = job.status === 'stopped';
  const beat = async () => {
    const [r] = await db
      .update(videoJobs)
      .set({ previewHeartbeatAt: sql`now()` })
      .where(mine)
      .returning({ status: videoJobs.status, cancel: videoJobs.cancelRequested, source: videoJobs.sourceState });
    if (!r) {
      const [other] = await db.select({ id: videoJobs.id }).from(videoJobs).where(eq(videoJobs.id, job.id));
      control.interrupt(other ? 'superseded' : 'gone');
    } else if (r.cancel || (!stoppedBefore && r.status === 'stopped') || r.source !== 'ready') control.interrupt('user');
    else if (!(await userMayTranslate(job.ownerId))) control.interrupt('revoked');
  };
  const stopBeat = startBeat(beat, opts.heartbeatMs ?? 2000);
  const key = storageKeys.videoPreview(job.ownerId, job.id);

  try {
    await beat();
    control.checkpoint();
    await appendVideoLog(job.id, 'info', 'previewStarted');
    await withTransientRetry(
      control,
      async () => {
        const media = job.media;
        if (!media || !job.sourceKey) throw new VideoFailure('SOURCE_DELETED');
        const dir = await makeVideoTempDir();
        try {
          // bản sao nguồn cộng bản xem trước (720p CRF 28 hiếm khi quá 4 Mbit/giây) và dư địa
          const estimate = Math.ceil(media.durationMs / 1000) * 500_000;
          if ((await (opts.freeBytes ?? defaultFreeBytes)(dir)) < job.fileSizeBytes + estimate + DISK_MARGIN) throw new VideoFailure('DISK_FULL');
          const source = path.join(dir, `source.${job.ext}`);
          try {
            await (opts.download ?? downloadObjectToFile)(job.sourceKey, source);
          } catch (e) {
            throw storageFailure(e);
          }
          control.checkpoint();
          const output = path.join(dir, 'preview.mp4');
          await runTrackedFfmpeg(previewArgs(source, output, media, job.ext), { signal: control.abort.signal, stallMs: opts.stallMs });
          const { size } = await stat(output);
          const { videoSystemCapBytes } = await getSettings();
          if ((await videoSystemBytes()) + size > videoSystemCapBytes) throw new VideoFailure('QUOTA_EXCEEDED');
          control.checkpoint();
          try {
            await uploadFileMultipart(key, output, 'video/mp4', { signal: control.abort.signal });
          } catch (e) {
            throw storageFailure(e);
          }
          const saved = await withVideoLock((tx) =>
            tx
              .update(videoJobs)
              .set({ previewState: 'ready', previewKey: key, previewBytes: size, previewHeartbeatAt: null })
              .where(and(mine, eq(videoJobs.sourceState, 'ready')))
              .returning({ id: videoJobs.id }),
          );
          if (saved.length === 0) {
            await beat();
            control.checkpoint();
            throw new JobGone();
          }
        } finally {
          await rm(dir, { recursive: true, force: true }).catch(() => undefined);
        }
      },
      {
        retry: { ...VIDEO_RETRY, ...opts.retry },
        onRetry: (attempt, max, wait) => appendVideoLog(job.id, 'warn', 'retrying', { attempt, max, sec: Math.round(wait / 100) / 10 }),
      },
    );
    await appendVideoLog(job.id, 'info', 'previewDone');
  } catch (e) {
    stopBeat();
    // lượt khác đã nhận lại: tệp và trạng thái thuộc lượt đó
    await beat().catch(() => undefined);
    if (control.superseded) return;
    await deleteObject(key).catch(() => undefined);
    if (e instanceof JobGone || control.gone) return;
    if (!(e instanceof JobStopped) && !control.stopped) {
      console.error(`[video-preview] ${job.id}: ${e instanceof VideoFailure ? `${e.code} ${e.detail}` : e instanceof Error ? e.message : ''}`);
    }
    const failed = await db.update(videoJobs).set({ previewState: 'failed', previewHeartbeatAt: null }).where(mine).returning({ id: videoJobs.id });
    if (failed.length > 0) await appendVideoLog(job.id, 'warn', 'previewFailed');
  } finally {
    stopBeat();
  }
}

export async function registerVideoPreview(boss: PgBoss): Promise<void> {
  // mỗi worker một bản xem trước cùng lúc (FR-052)
  await boss.work<VideoPreviewPayload>(QUEUES.videoPreview, { localConcurrency: 1 }, async (jobs) => {
    for (const j of jobs) await runVideoPreview(j.data.jobId);
  });
}
