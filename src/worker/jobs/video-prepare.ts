import { createReadStream } from 'node:fs';
import { rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { and, eq, inArray, isNull, lt, notInArray, or, sql } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import {
  demuxerOf,
  extractAudioArgs,
  MediaUnreadableError,
  NoAudioStreamError,
  NoVideoStreamError,
  probeVideo,
  VideoResolutionError,
  VideoTooLongError,
} from '../../lib/audio/ffmpeg';
import { getDb, type Db } from '../../lib/db';
import { VIDEO_PIPELINE_ACTIVE, videoJobs } from '../../lib/db/schema';
import { getSettings } from '../../lib/settings';
import { deleteByPrefix, deleteObject, downloadObjectToFile, putObjectStream } from '../../lib/storage/client';
import { storageKeys } from '../../lib/storage/keys';
import { recomputeSourceExpiry } from '../../lib/video/expiry';
import { appendVideoLog, type VideoLogKey, type VideoLogLevel } from '../../lib/video/log';
import { userMayTranslate } from '../../lib/video/permission';
import { addVideoUsed, withVideoLock } from '../../lib/video/quota';
import type { VideoMedia } from '../../lib/video/types';
import type { RetryPolicy } from '../pipeline/synthesize-segment';
import { enqueueVideoPreview, enqueueVideoTranslate, QUEUES, type VideoPreparePayload } from '../queues';
import {
  cleanupStaleVideoTempDirs,
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
  type VideoErrorCode,
} from '../video/run';

/**
 * Chuẩn bị video đã tải xong (spec 006, FR-003, FR-009): kiểm đĩa tạm → tải nguồn → đo và từ chối tệp không đạt → tách âm thanh giữ
 * đúng độ lệch → xếp việc dịch (và bản xem trước nếu cần). Video tải LẠI cho việc đã có kịch bản chỉ được kiểm tra (FR-046).
 * Lỗi tạm thử lại tối đa 3 lần; lỗi vĩnh viễn không thử lại (FR-051).
 */
export type VideoPrepareOptions = {
  retry?: Partial<RetryPolicy>;
  heartbeatMs?: number;
  stallMs?: number;
  freeBytes?: (dir: string) => Promise<number>;
  /** tải nguồn từ kho (kiểm thử lỗi kho lưu tệp) */
  download?: (key: string, file: string) => Promise<void>;
  enqueueTranslate?: (jobId: string) => Promise<unknown>;
  enqueuePreview?: (jobId: string) => Promise<unknown>;
};

/** Chỗ trống tối thiểu ngoài bản sao video nguồn: âm thanh tách và dư địa. */
const DISK_MARGIN = 1024 ** 3;
const CHECK_STALE_MS = 30_000;
/** Mã lỗi cho thấy chính tệp không dùng được: tệp bị bỏ và dung lượng được trả lại. */
const REJECTS: ReadonlySet<VideoErrorCode> = new Set<VideoErrorCode>(['SOURCE_UNREADABLE', 'VIDEO_UNSUPPORTED', 'NO_AUDIO_STREAM', 'VIDEO_TOO_LONG']);

type Job = typeof videoJobs.$inferSelect;

/** Nguồn cần bản xem trước khi trình duyệt không phát được phổ biến, lớn hơn 1080p hoặc trên 8 Mbps (research R11). */
export const needsPreview = (m: VideoMedia): boolean => !m.browserPlayable || Math.min(m.width, m.height) > 1080 || m.videoBitrate > 8_000_000;

/** Nhận việc của pipeline: đang chờ hoặc bị gián đoạn và chưa tách xong âm thanh. */
async function claimPipeline(jobId: string): Promise<Job | null> {
  const [row] = await getDb()
    .update(videoJobs)
    .set({
      status: 'preparing',
      stageKey: 'preparing',
      attempt: sql`${videoJobs.attempt} + 1`,
      heartbeatAt: sql`now()`,
      startedAt: sql`coalesce(${videoJobs.startedAt}, now())`,
      errorCode: null,
      finishedAt: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(videoJobs.id, jobId),
        inArray(videoJobs.status, ['queued', 'interrupted']),
        eq(videoJobs.cancelRequested, false),
        or(isNull(videoJobs.audioTempKey), isNull(videoJobs.media)),
      ),
    )
    .returning();
  return row ?? null;
}

/** Nhận việc kiểm video tải lại: pipeline không chạy, nguồn đang chờ kiểm và chưa ai giữ. */
async function claimCheck(jobId: string): Promise<Job | null> {
  const [row] = await getDb()
    .update(videoJobs)
    .set({ heartbeatAt: sql`now()` })
    .where(
      and(
        eq(videoJobs.id, jobId),
        eq(videoJobs.sourceState, 'checking'),
        notInArray(videoJobs.status, [...VIDEO_PIPELINE_ACTIVE]),
        or(isNull(videoJobs.heartbeatAt), lt(videoJobs.heartbeatAt, sql`now() - (${CHECK_STALE_MS} * interval '1 millisecond')`)),
      ),
    )
    .returning();
  return row ?? null;
}

/** Tải video nguồn về đĩa tạm rồi đo. Tệp được coi là không tin cậy. */
async function fetchAndProbe(job: Job, dir: string, maxMinutes: number, control: RunControl, opts: VideoPrepareOptions): Promise<{ source: string; media: VideoMedia }> {
  if (!job.sourceKey) throw new VideoFailure('SOURCE_DELETED');
  if ((await (opts.freeBytes ?? defaultFreeBytes)(dir)) < job.fileSizeBytes + DISK_MARGIN) throw new VideoFailure('DISK_FULL');
  const source = path.join(dir, `source.${job.ext}`);
  try {
    await (opts.download ?? downloadObjectToFile)(job.sourceKey, source);
  } catch (e) {
    throw storageFailure(e);
  }
  control.checkpoint();
  try {
    return { source, media: await probeVideo(source, { demuxer: demuxerOf(job.ext), maxMinutes }) };
  } catch (e) {
    if (e instanceof MediaUnreadableError) throw new VideoFailure('SOURCE_UNREADABLE', e.message);
    if (e instanceof NoVideoStreamError || e instanceof VideoResolutionError) throw new VideoFailure('VIDEO_UNSUPPORTED', e.message);
    if (e instanceof NoAudioStreamError) throw new VideoFailure('NO_AUDIO_STREAM');
    if (e instanceof VideoTooLongError) throw new VideoFailure('VIDEO_TOO_LONG');
    throw e;
  }
}

/** Bỏ tệp nguồn không dùng được và trả dung lượng. */
async function dropSource(job: Job, state: 'rejected' | 'deleted'): Promise<void> {
  const key = await withVideoLock(async (tx) => {
    const [row] = await tx.select({ key: videoJobs.sourceKey, size: videoJobs.fileSizeBytes }).from(videoJobs).where(eq(videoJobs.id, job.id)).for('update');
    if (!row) return null;
    await tx.update(videoJobs).set({ sourceKey: null, sourceState: state, updatedAt: new Date() }).where(eq(videoJobs.id, job.id));
    if (row.key) await addVideoUsed(job.ownerId, -row.size, tx);
    await recomputeSourceExpiry(job.id, tx);
    return row.key;
  });
  if (key) await deleteObject(key).catch(() => undefined);
}

async function schedulePreview(job: Job, media: VideoMedia, opts: VideoPrepareOptions): Promise<void> {
  if (!needsPreview(media)) return;
  const marked = await getDb()
    .update(videoJobs)
    .set({ previewState: 'pending', previewHeartbeatAt: null, previewAttempt: 0 })
    .where(and(eq(videoJobs.id, job.id), inArray(videoJobs.previewState, ['none', 'failed'])))
    .returning({ id: videoJobs.id });
  if (marked.length > 0) await (opts.enqueuePreview ?? enqueueVideoPreview)(job.id).catch(() => undefined); // sweeper xếp lại nếu mất
}

const logger = (job: Job, control: RunControl) => async (level: VideoLogLevel, key: VideoLogKey, params?: Record<string, string | number>) => {
  if (!control.gone) await appendVideoLog(job.id, level, key, params);
};

async function logMedia(log: ReturnType<typeof logger>, media: VideoMedia): Promise<void> {
  await log('info', 'probed', { width: media.width, height: media.height, sec: Math.round(media.durationMs / 100) / 10 });
  // nêu rõ đang dùng luồng tiếng nào (edge case nhiều luồng tiếng)
  if (media.audioStreams > 1) await log('info', 'audioStream', { count: media.audioStreams, n: media.audioIndex });
}

async function runPipeline(job: Job, opts: VideoPrepareOptions): Promise<void> {
  const db = getDb();
  const control = new RunControl();
  const retry: RetryPolicy = { ...VIDEO_RETRY, ...opts.retry };
  const mine = and(eq(videoJobs.id, job.id), eq(videoJobs.status, 'preparing'), eq(videoJobs.attempt, job.attempt));
  const log = logger(job, control);
  let progress = job.progressPercent > 10 ? 10 : 0;
  let finished = false;

  const beat = async () => {
    if (finished) return;
    const [r] = await db.update(videoJobs).set({ heartbeatAt: sql`now()`, progressPercent: progress }).where(mine).returning({ cancel: videoJobs.cancelRequested });
    if (finished) return;
    if (!r) {
      const [other] = await db.select({ id: videoJobs.id }).from(videoJobs).where(eq(videoJobs.id, job.id));
      control.interrupt(other ? 'superseded' : 'gone');
    } else if (r.cancel) control.interrupt('user');
    else if (!(await userMayTranslate(job.ownerId))) control.interrupt('revoked');
  };
  const stopBeat = startBeat(beat, opts.heartbeatMs ?? 2000);

  try {
    await beat();
    await log('info', job.interruptions > 0 ? 'resumed' : 'preparing', job.interruptions > 0 ? { attempt: job.interruptions + 1 } : undefined);
    const { videoMaxMinutes } = await getSettings();
    await withTransientRetry(
      control,
      async () => {
        const dir = await makeVideoTempDir();
        try {
          const { source, media } = await fetchAndProbe(job, dir, videoMaxMinutes, control, opts);
          control.checkpoint();
          const saved = await db.transaction(async (tx) => {
            const r = await tx.update(videoJobs).set({ media, sourceState: 'ready', updatedAt: new Date() }).where(mine).returning({ id: videoJobs.id });
            if (r.length) await recomputeSourceExpiry(job.id, tx as unknown as Db);
            return r.length > 0;
          });
          if (!saved) {
            await beat();
            control.checkpoint();
          }
          await logMedia(log, media);
          await schedulePreview(job, media, opts);
          progress = 3;
          await log('info', 'extracting');
          const audio = path.join(dir, 'audio.mp3');
          await runTrackedFfmpeg(['-threads', String(videoThreads()), ...extractAudioArgs(source, audio, { audioIndex: media.audioIndex, demuxer: demuxerOf(job.ext) })], {
            signal: control.abort.signal,
            stallMs: opts.stallMs,
            onTime: (ms) => {
              progress = Math.max(progress, Math.min(9, 3 + Math.floor((ms / media.durationMs) * 6)));
            },
          });
          const { size } = await stat(audio);
          await log('info', 'extracted', { kb: Math.round(size / 1024) });
          const key = storageKeys.videoAudio(job.ownerId, job.id);
          try {
            await putObjectStream(key, createReadStream(audio), size, 'audio/mpeg');
          } catch (e) {
            throw storageFailure(e);
          }
          control.checkpoint();
          const done = await db
            .update(videoJobs)
            .set({ audioTempKey: key, status: 'queued', stageKey: 'queued', progressPercent: 10, heartbeatAt: null, updatedAt: new Date() })
            .where(and(mine, eq(videoJobs.cancelRequested, false)))
            .returning({ id: videoJobs.id });
          if (done.length === 0) {
            await beat();
            control.checkpoint();
            throw new JobGone();
          }
          finished = true;
        } finally {
          await rm(dir, { recursive: true, force: true }).catch(() => undefined);
        }
      },
      { retry, onRetry: (attempt, max, wait) => log('warn', 'retrying', { attempt, max, sec: Math.round(wait / 100) / 10 }) },
    );
    stopBeat();
    await (opts.enqueueTranslate ?? enqueueVideoTranslate)(job.id).catch((e) => console.error('[video-prepare] không xếp được việc dịch:', e instanceof Error ? e.message : e));
  } catch (e) {
    stopBeat();
    // lượt này còn giữ việc không: nếu lượt khác đã nhận lại thì không đụng vào dữ liệu của lượt đó
    await beat().catch(() => undefined);
    finished = true;
    if (control.superseded) return;
    if (e instanceof JobGone || control.gone) {
      await deleteByPrefix(storageKeys.videoJobTempPrefix(job.ownerId, job.id)).catch(() => undefined);
      return;
    }
    if (e instanceof JobStopped || control.stopped) {
      const revoked = control.stopped === 'revoked';
      await db.transaction(async (tx) => {
        await tx
          .update(videoJobs)
          .set({ status: 'stopped', stageKey: 'stopped', errorCode: revoked ? 'PERMISSION_REVOKED' : null, cancelRequested: false, finishedAt: new Date(), updatedAt: new Date() })
          .where(mine);
        await recomputeSourceExpiry(job.id, tx as unknown as Db);
      });
      await appendVideoLog(job.id, 'warn', 'stopped');
      return;
    }
    const code: VideoErrorCode = e instanceof VideoFailure ? e.code : 'INTERNAL';
    if (!(e instanceof VideoFailure) || e.detail) console.error(`[video-prepare] ${job.id} ${code}: ${e instanceof VideoFailure ? e.detail : e instanceof Error ? e.message : ''}`);
    if (REJECTS.has(code)) await dropSource(job, 'rejected');
    await db.transaction(async (tx) => {
      await tx
        .update(videoJobs)
        .set({ status: 'failed', stageKey: 'failed', errorCode: code, cancelRequested: false, finishedAt: new Date(), updatedAt: new Date() })
        .where(mine);
      await recomputeSourceExpiry(job.id, tx as unknown as Db);
    });
    await appendVideoLog(job.id, 'error', 'failed', { reason: code });
  } finally {
    stopBeat();
  }
}

/** Video tải lại: chỉ kiểm tệp rồi mở lại việc xuất; trạng thái pipeline và kịch bản giữ nguyên. */
async function runCheck(job: Job, opts: VideoPrepareOptions): Promise<void> {
  const db = getDb();
  const control = new RunControl();
  const mine = and(eq(videoJobs.id, job.id), eq(videoJobs.sourceState, 'checking'));
  const log = logger(job, control);
  const stopBeat = startBeat(async () => {
    const r = await db.update(videoJobs).set({ heartbeatAt: sql`now()` }).where(mine).returning({ id: videoJobs.id });
    if (r.length === 0) control.interrupt('gone');
  }, opts.heartbeatMs ?? 2000);
  try {
    await log('info', 'preparing');
    await withTransientRetry(
      control,
      async () => {
        const dir = await makeVideoTempDir();
        try {
          // việc đã có thì giữ nguyên dù Administrator hạ giới hạn thời lượng sau đó
          const { media } = await fetchAndProbe(job, dir, Number.MAX_SAFE_INTEGER, control, opts);
          control.checkpoint();
          await db.transaction(async (tx) => {
            await tx.update(videoJobs).set({ media, sourceState: 'ready', heartbeatAt: null, updatedAt: new Date() }).where(mine);
            await recomputeSourceExpiry(job.id, tx as unknown as Db);
          });
          await logMedia(log, media);
          await schedulePreview(job, media, opts);
        } finally {
          await rm(dir, { recursive: true, force: true }).catch(() => undefined);
        }
      },
      { retry: { ...VIDEO_RETRY, ...opts.retry }, onRetry: (attempt, max, wait) => log('warn', 'retrying', { attempt, max, sec: Math.round(wait / 100) / 10 }) },
    );
  } catch (e) {
    if (e instanceof JobGone || control.gone) return;
    const code: VideoErrorCode = e instanceof VideoFailure ? e.code : 'INTERNAL';
    await appendVideoLog(job.id, 'error', 'failed', { reason: code });
    if (REJECTS.has(code)) await dropSource(job, 'deleted');
    // lỗi tạm: giữ tệp, sweeper xếp lại; quá số lần thì bỏ tệp để người dùng tải lại
    else {
      const [r] = await db
        .update(videoJobs)
        .set({ interruptions: sql`${videoJobs.interruptions} + 1`, heartbeatAt: sql`now()` })
        .where(mine)
        .returning({ n: videoJobs.interruptions });
      if (r && r.n > 3) await dropSource(job, 'deleted');
    }
  } finally {
    stopBeat();
  }
}

export async function runVideoPrepare(jobId: string, opts: VideoPrepareOptions = {}): Promise<void> {
  const pipeline = await claimPipeline(jobId);
  if (pipeline) return runPipeline(pipeline, opts);
  const check = await claimCheck(jobId);
  if (check) await runCheck(check, opts);
}

export async function registerVideoPrepare(boss: PgBoss): Promise<void> {
  await cleanupStaleVideoTempDirs();
  // mỗi worker một việc chuẩn bị cùng lúc (FR-052)
  await boss.work<VideoPreparePayload>(QUEUES.videoPrepare, { localConcurrency: 1 }, async (jobs) => {
    for (const j of jobs) await runVideoPrepare(j.data.jobId);
  });
}
