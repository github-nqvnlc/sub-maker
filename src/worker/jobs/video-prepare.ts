import { createReadStream } from 'node:fs';
import { rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { and, eq, inArray, isNull, lt, notInArray, or, sql } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import {
  audioDemuxerOf,
  demuxerOf,
  extractAudioArgs,
  MediaUnreadableError,
  NoAudioStreamError,
  NoVideoStreamError,
  probeAudio,
  probeVideo,
  VideoResolutionError,
  VideoTooLongError,
} from '../../lib/audio/ffmpeg';
import { getDb, type Db } from '../../lib/db';
import { VIDEO_PIPELINE_ACTIVE, videoCues, videoJobs, videoUploads } from '../../lib/db/schema';
import { getSettings } from '../../lib/settings';
import { deleteByPrefix, deleteObject, downloadObjectToFile, putObjectStream } from '../../lib/storage/client';
import { storageKeys } from '../../lib/storage/keys';
import { releaseBytes, reserveBytes } from '../../lib/storage/quota';
import { loadCues } from '../../lib/video/cues';
import { recomputeSourceExpiry } from '../../lib/video/expiry';
import { appendVideoLog, type VideoLogKey, type VideoLogLevel } from '../../lib/video/log';
import { userMayTranslate } from '../../lib/video/permission';
import { addVideoUsed, withVideoLock } from '../../lib/video/quota';
import { needsPreview } from '../../lib/video/status';
import { CUE_LIMITS, cueBytes, type VideoMedia } from '../../lib/video/types';
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
async function dropSource(job: Job, state: 'rejected' | 'deleted', errorCode?: VideoErrorCode): Promise<void> {
  const key = await withVideoLock(async (tx) => {
    const [row] = await tx.select({ key: videoJobs.sourceKey, size: videoJobs.fileSizeBytes }).from(videoJobs).where(eq(videoJobs.id, job.id)).for('update');
    if (!row) return null;
    await tx.update(videoJobs).set({ sourceKey: null, sourceState: state, ...(errorCode ? { errorCode } : {}), updatedAt: new Date() }).where(eq(videoJobs.id, job.id));
    if (row.key) await addVideoUsed(job.ownerId, -row.size, tx);
    await recomputeSourceExpiry(job.id, tx);
    return row.key;
  });
  if (key) await deleteObject(key).catch(() => undefined);
}

/** Dời mốc mọi cue đã có theo độ lệch đầu luồng tiếng (không tính phí lại) (FR-011). */
async function shiftJobCues(tx: Db, job: Job, deltaMs: number, maxDurationMs: number): Promise<boolean> {
  const existing = await loadCues(job.id, tx);
  if (existing.length === 0) return false;
  const shifted = existing
    .map((c) => ({
      ...c,
      startMs: Math.max(0, Math.min(maxDurationMs, c.startMs + deltaMs)),
      endMs: Math.max(0, Math.min(maxDurationMs, c.endMs + deltaMs)),
    }))
    .filter((c) => c.endMs - c.startMs >= CUE_LIMITS.minDurationMs);
  for (let i = 1; i < shifted.length; i++) {
    const prev = shifted[i - 1]!;
    const cur = shifted[i]!;
    if (cur.startMs < prev.endMs) cur.startMs = prev.endMs;
  }
  const valid = shifted.filter((c) => c.endMs - c.startMs >= CUE_LIMITS.minDurationMs);
  await tx.delete(videoCues).where(eq(videoCues.jobId, job.id));
  for (let i = 0; i < valid.length; i += 1000) {
    await tx.insert(videoCues).values(valid.slice(i, i + 1000).map((c) => ({ ...c, jobId: job.id })));
  }
  const bytes = valid.reduce((n, c) => n + cueBytes(c), 0);
  const delta = bytes - job.scriptBytes;
  if (delta > 0) await reserveBytes(job.ownerId, delta, { soft: true, db: tx });
  else if (delta < 0) await releaseBytes(job.ownerId, -delta, tx);
  await tx
    .update(videoJobs)
    .set({ cueCount: valid.length, cueRevision: sql`${videoJobs.cueRevision} + 1`, scriptBytes: bytes, updatedAt: new Date() })
    .where(eq(videoJobs.id, job.id));
  return true;
}

/** Chuẩn bị từ tệp âm thanh do trình duyệt gửi lên (không tin cậy; FR-010). */
async function fetchAndPrepareClientAudio(
  job: Job,
  upload: typeof videoUploads.$inferSelect,
  dir: string,
  maxMinutes: number,
  control: RunControl,
  opts: VideoPrepareOptions,
): Promise<{ source: string; ext: string; demuxer: ReturnType<typeof audioDemuxerOf>; media: VideoMedia; audioIndex: number; durationMs: number }> {
  const ext = path.extname(upload.key).slice(1).toLowerCase() || 'm4a';
  const demuxer = audioDemuxerOf(ext);
  if ((await (opts.freeBytes ?? defaultFreeBytes)(dir)) < upload.sizeBytes * 2 + 64 * 1024 * 1024) throw new VideoFailure('DISK_FULL');
  const source = path.join(dir, `audio-client.${ext}`);
  try {
    await (opts.download ?? downloadObjectToFile)(upload.key, source);
  } catch (e) {
    throw storageFailure(e);
  }
  control.checkpoint();
  let info: Awaited<ReturnType<typeof probeAudio>>;
  try {
    info = await probeAudio(source, { demuxer, maxMinutes });
  } catch (e) {
    if (e instanceof MediaUnreadableError) throw new VideoFailure('SOURCE_UNREADABLE', e.message);
    if (e instanceof NoAudioStreamError) throw new VideoFailure('NO_AUDIO_STREAM');
    if (e instanceof VideoTooLongError) throw new VideoFailure('VIDEO_TOO_LONG');
    throw e;
  }
  const media: VideoMedia = {
    durationMs: info.startMs + info.durationMs,
    width: 1280,
    height: 720,
    fps: 30,
    videoCodec: 'pending',
    videoBitrate: 0,
    audioCodec: info.codec,
    audioIndex: info.audioIndex,
    audioStartMs: info.startMs,
    audioDurationMs: info.durationMs,
    audioStreams: 1,
    rotation: 0,
    hdr: false,
    matrix: 'bt709',
    browserPlayable: false,
    clientAudio: { startMs: info.startMs, durationMs: info.durationMs },
  };
  return { source, ext, demuxer, media, audioIndex: info.audioIndex, durationMs: Math.max(1, info.durationMs) };
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
  if (media.audioStreams > 1) await log('info', 'audioStream', { count: media.audioStreams, n: media.audioNumber ?? 1 });
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

  let clientTempKey: string | null = null;
  try {
    await beat();
    await log('info', job.interruptions > 0 ? 'resumed' : 'preparing', job.interruptions > 0 ? { attempt: job.interruptions + 1 } : undefined);
    const { videoMaxMinutes } = await getSettings();
    const [clientUpload] = job.sourceKey
      ? []
      : await db
          .select()
          .from(videoUploads)
          .where(and(eq(videoUploads.jobId, job.id), eq(videoUploads.kind, 'client_audio'), eq(videoUploads.state, 'completed')))
          .limit(1);
    clientTempKey = clientUpload?.key ?? null;

    await withTransientRetry(
      control,
      async () => {
        const dir = await makeVideoTempDir();
        try {
          let source: string;
          let media: VideoMedia;
          let audioArgs: string[];
          if (job.sourceKey) {
            const probed = await fetchAndProbe(job, dir, videoMaxMinutes, control, opts);
            source = probed.source;
            media = probed.media;
            control.checkpoint();
            const saved = await db.transaction(async (tx) => {
              const r = await tx.update(videoJobs).set({ media, sourceState: 'ready', audioMismatch: false, updatedAt: new Date() }).where(mine).returning({ id: videoJobs.id });
              if (r.length) await recomputeSourceExpiry(job.id, tx as unknown as Db);
              return r.length > 0;
            });
            if (!saved) {
              await beat();
              control.checkpoint();
            }
            await logMedia(log, media);
            await schedulePreview(job, media, opts);
            audioArgs = extractAudioArgs(source, path.join(dir, 'audio.mp3'), { audioIndex: media.audioIndex, demuxer: demuxerOf(job.ext) });
          } else {
            if (!clientUpload) throw new VideoFailure('SOURCE_DELETED');
            const ca = await fetchAndPrepareClientAudio(job, clientUpload, dir, videoMaxMinutes, control, opts);
            source = ca.source;
            media = ca.media;
            control.checkpoint();
            const saved = await db.transaction(async (tx) => {
              const r = await tx
                .update(videoJobs)
                .set({ media, updatedAt: new Date() })
                .where(and(mine, isNull(videoJobs.media)))
                .returning({ id: videoJobs.id });
              return r.length > 0;
            });
            if (!saved) {
              await beat();
              control.checkpoint();
            }
            audioArgs = extractAudioArgs(source, path.join(dir, 'audio.mp3'), { audioIndex: ca.audioIndex, demuxer: ca.demuxer });
          }
          progress = 3;
          await log('info', 'extracting');
          const audio = path.join(dir, 'audio.mp3');
          await runTrackedFfmpeg(['-threads', String(videoThreads()), ...audioArgs], {
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
          if (clientTempKey) await deleteObject(clientTempKey).catch(() => undefined);
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
          .set({ status: 'stopped', stageKey: 'stopped', errorCode: revoked ? 'PERMISSION_REVOKED' : null, cancelRequested: false, heartbeatAt: null, finishedAt: new Date(), updatedAt: new Date() })
          .where(mine);
        await recomputeSourceExpiry(job.id, tx as unknown as Db);
      });
      await appendVideoLog(job.id, 'warn', 'stopped');
      return;
    }
    const code: VideoErrorCode = e instanceof VideoFailure ? e.code : 'INTERNAL';
    if (!(e instanceof VideoFailure) || e.detail) console.error(`[video-prepare] ${job.id} ${code}: ${e instanceof VideoFailure ? e.detail : e instanceof Error ? e.message : ''}`);
    if (REJECTS.has(code)) {
      if (job.sourceKey) await dropSource(job, 'rejected', code);
      if (clientTempKey) await deleteObject(clientTempKey).catch(() => undefined);
    }
    await db.transaction(async (tx) => {
      await tx
        .update(videoJobs)
        .set({ status: 'failed', stageKey: 'failed', errorCode: code, cancelRequested: false, heartbeatAt: null, finishedAt: new Date(), updatedAt: new Date() })
        .where(mine);
      await recomputeSourceExpiry(job.id, tx as unknown as Db);
    });
    await appendVideoLog(job.id, 'error', 'failed', { reason: code });
  } finally {
    stopBeat();
  }
}

/** Video tải lại hoặc video tải xong sau luồng nhanh: kiểm tệp, đối chiếu âm thanh trình duyệt (nếu có) rồi mở lại việc xuất. */
async function runCheck(job: Job, opts: VideoPrepareOptions): Promise<void> {
  const db = getDb();
  const control = new RunControl();
  const mine = and(eq(videoJobs.id, job.id), eq(videoJobs.sourceState, 'checking'));
  const log = logger(job, control);
  const firstSource = !job.media || job.media.videoCodec === 'pending';
  const stopBeat = startBeat(async () => {
    const r = await db.update(videoJobs).set({ heartbeatAt: sql`now()` }).where(mine).returning({ id: videoJobs.id });
    if (r.length === 0) control.interrupt('gone');
  }, opts.heartbeatMs ?? 2000);
  try {
    await log('info', 'preparing');
    const { videoMaxMinutes } = await getSettings();
    await withTransientRetry(
      control,
      async () => {
        const dir = await makeVideoTempDir();
        try {
          // việc đã có (FR-046) thì giữ nguyên dù Administrator hạ giới hạn thời lượng; tải lần đầu sau luồng nhanh vẫn kiểm giới hạn (FR-003)
          const { media } = await fetchAndProbe(job, dir, firstSource ? videoMaxMinutes : Number.MAX_SAFE_INTEGER, control, opts);
          control.checkpoint();
          const outcome = await db.transaction(async (tx) => {
            const dbTx = tx as unknown as Db;
            const [cur] = await tx.select().from(videoJobs).where(mine).for('update');
            if (!cur) return { shifted: 0, mismatch: null as { clientSec: number; sourceSec: number } | null };
            const ca = cur.clientAudio && cur.media?.videoCodec === 'pending' ? cur.media.clientAudio : undefined;
            const deltaMs = ca ? media.audioStartMs - ca.startMs : 0;
            const mismatch = ca && Math.abs(media.audioDurationMs - ca.durationMs) > 1000;
            let shifted = 0;
            if (ca && Math.abs(deltaMs) > 100 && cur.cueCount > 0) {
              if (await shiftJobCues(dbTx, cur, deltaMs, media.durationMs)) shifted = deltaMs;
            }
            await tx
              .update(videoJobs)
              .set({ media, sourceState: 'ready', audioMismatch: !!mismatch, heartbeatAt: null, updatedAt: new Date() })
              .where(eq(videoJobs.id, cur.id));
            await recomputeSourceExpiry(job.id, dbTx);
            return {
              shifted,
              mismatch: mismatch ? { clientSec: Math.round(ca.durationMs / 100) / 10, sourceSec: Math.round(media.audioDurationMs / 100) / 10 } : null,
            };
          });
          await logMedia(log, media);
          if (outcome.shifted !== 0) await log('info', 'cuesShifted', { ms: outcome.shifted });
          if (outcome.mismatch) await log('warn', 'audioMismatch', outcome.mismatch);
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
    if (REJECTS.has(code)) await dropSource(job, firstSource ? 'rejected' : 'deleted', firstSource ? code : undefined);
    else {
      const [r] = await db
        .update(videoJobs)
        .set({ interruptions: sql`${videoJobs.interruptions} + 1`, heartbeatAt: null })
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
