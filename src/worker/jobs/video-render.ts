import { rm } from 'node:fs/promises';
import path from 'node:path';
import { and, eq, gt, inArray, lt, sql } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import { demuxerOf } from '../../lib/audio/ffmpeg';
import { getDb, type Db } from '../../lib/db';
import { users, videoExports, videoJobs } from '../../lib/db/schema';
import { sleep } from '../../lib/providers/adapters/shared';
import { getSettings } from '../../lib/settings';
import { deleteObject, downloadObjectToFile, uploadFileMultipart } from '../../lib/storage/client';
import { storageKeys } from '../../lib/storage/keys';
import { burnMaxrate, burnOutputSize, COPY_AUDIO_CODECS } from '../../lib/video/estimate';
import { recomputeSourceExpiry } from '../../lib/video/expiry';
import { appendVideoLog, type VideoLogKey, type VideoLogLevel } from '../../lib/video/log';
import { userMayTranslate } from '../../lib/video/permission';
import { addVideoUsed, videoReservedBytes, videoSystemBytes, withVideoLock } from '../../lib/video/quota';
import { parseStoredStyle, toAppliedCues, toSceneStyle } from '../../lib/video/style';
import type { RetryPolicy } from '../pipeline/synthesize-segment';
import { QUEUES, type VideoRenderPayload } from '../queues';
import type { BurnTask } from '../render/protocol';
import { spawnRender, type RenderHandle, type SpawnRender } from '../render/spawn-render';
import {
  defaultFreeBytes,
  JobGone,
  JobStopped,
  makeVideoTempDir,
  RunControl,
  startBeat,
  storageFailure,
  VIDEO_RETRY,
  VideoFailure,
  videoThreads,
  withTransientRetry,
  type VideoErrorCode,
} from '../video/run';

/**
 * Xuất video gắn cứng phụ đề (spec 006, US3; FR-037, FR-049 đến FR-053). Luồng: nhận việc (giới hạn đồng thời toàn hệ thống) → kiểm
 * đĩa tạm → tải video nguồn → tiến trình con dựng hình → đưa thành phẩm lên kho theo multipart → MỘT giao dịch trừ hạn mức và hoàn tất.
 * Tiến độ 50–95% khi dựng, 95–100% khi lưu. Lỗi tạm thử lại tối đa 3 lần; lỗi vĩnh viễn không thử lại.
 */
export type VideoRenderOptions = {
  retry?: Partial<RetryPolicy>;
  heartbeatMs?: number;
  admissionPollMs?: number;
  stallMs?: number;
  /** thay tiến trình con trong kiểm thử */
  spawnRender?: SpawnRender<BurnTask>;
  freeBytes?: (dir: string) => Promise<number>;
  download?: (key: string, file: string) => Promise<void>;
  upload?: typeof uploadFileMultipart;
};

/** Khóa tư vấn: đếm số đang chạy rồi mới nhận phải nguyên tử. */
const ADMISSION_LOCK = 727_013;
/** Bản đang chờ được coi là còn người xử lý khi vừa chạm nhịp tim (chọn bản tạo trước). */
const WAITING_FRESH_MS = 10_000;
const DISK_MARGIN = 1024 ** 3;
const FONT_DIR = () => path.resolve(process.cwd(), 'public/fonts/overlay');
/** Số việc xuất một worker nhận cùng lúc; phần vượt giới hạn hệ thống nằm chờ trong lượt nhận. */
export const VIDEO_RENDER_LOCAL_CONCURRENCY = 4;

type Row = typeof videoExports.$inferSelect;

async function tryClaim(exportId: string): Promise<{ row: Row } | { wait: number } | null> {
  const { maxConcurrentVideoRenders } = await getSettings();
  return getDb().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${ADMISSION_LOCK})`);
    const [cur] = await tx
      .select({ status: videoExports.status, cancel: videoExports.cancelRequested, createdAt: videoExports.createdAt })
      .from(videoExports)
      .where(eq(videoExports.id, exportId));
    if (!cur || (cur.status !== 'queued' && cur.status !== 'interrupted') || cur.cancel) return null;
    const [running] = await tx.select({ n: sql<number>`count(*)::int` }).from(videoExports).where(eq(videoExports.status, 'running'));
    const [older] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(videoExports)
      .where(
        and(
          inArray(videoExports.status, ['queued', 'interrupted']),
          lt(videoExports.createdAt, cur.createdAt),
          gt(videoExports.heartbeatAt, sql`now() - (${WAITING_FRESH_MS} * interval '1 millisecond')`),
        ),
      );
    if (maxConcurrentVideoRenders - (running?.n ?? 0) <= (older?.n ?? 0)) {
      await tx.update(videoExports).set({ heartbeatAt: sql`now()` }).where(eq(videoExports.id, exportId));
      return { wait: maxConcurrentVideoRenders };
    }
    const [row] = await tx
      .update(videoExports)
      .set({ status: 'running', attempt: sql`${videoExports.attempt} + 1`, heartbeatAt: sql`now()`, startedAt: sql`coalesce(${videoExports.startedAt}, now())`, progressPercent: 50, errorCode: null, finishedAt: null })
      .where(eq(videoExports.id, exportId))
      .returning();
    return row ? { row } : null;
  });
}

async function claim(exportId: string, opts: VideoRenderOptions): Promise<Row | null> {
  let announced = false;
  for (;;) {
    const r = await tryClaim(exportId);
    if (!r) return null;
    if ('row' in r) return r.row;
    if (!announced) {
      announced = true;
      const [row] = await getDb().select({ jobId: videoExports.jobId }).from(videoExports).where(eq(videoExports.id, exportId));
      if (row) await appendVideoLog(row.jobId, 'info', 'waiting', { max: r.wait }, { exportId });
    }
    await sleep(opts.admissionPollMs ?? 2000);
  }
}

/** Chỗ còn lại cho thành phẩm của bản xuất đang chạy: hạn mức người dùng và trần hệ thống, không tính chỗ chính nó đang giữ. */
async function roomFor(row: Pick<Row, 'ownerId' | 'estimatedBytes'>, db: Db = getDb()): Promise<number> {
  const settings = await getSettings(db);
  const [u] = await db.select({ used: users.videoUsedBytes }).from(users).where(eq(users.id, row.ownerId));
  if (!u) throw new JobGone();
  const others = (await videoReservedBytes(row.ownerId, db)) - row.estimatedBytes;
  const system = (await videoSystemBytes(db)) - row.estimatedBytes;
  return Math.max(0, Math.min(settings.userVideoQuotaBytes - u.used - others, settings.videoSystemCapBytes - system));
}

const FAILURES: ReadonlySet<string> = new Set<VideoErrorCode>(['SOURCE_UNREADABLE', 'QUOTA_EXCEEDED', 'DISK_FULL', 'RENDER_FAILED', 'RENDER_STALLED']);

export async function runVideoRender(exportId: string, opts: VideoRenderOptions = {}): Promise<void> {
  const db = getDb();
  const row = await claim(exportId, opts);
  if (!row) return; // đã xóa, đã dừng, hoặc worker khác đang chạy

  const control = new RunControl();
  const retry: RetryPolicy = { ...VIDEO_RETRY, ...opts.retry };
  const spawn: SpawnRender<BurnTask> = opts.spawnRender ?? spawnRender;
  const mine = and(eq(videoExports.id, row.id), eq(videoExports.status, 'running'), eq(videoExports.attempt, row.attempt));
  const key = storageKeys.videoExport(row.ownerId, row.jobId, row.id, row.format, row.attempt);
  let progress = 50;
  let finished = false;
  let completed = false;

  const log = async (level: VideoLogLevel, messageKey: VideoLogKey, params?: Record<string, string | number>) => {
    if (!control.gone) await appendVideoLog(row.jobId, level, messageKey, params, { exportId: row.id });
  };
  // Nhịp tim: ghi tiến độ, phát hiện bị xóa, yêu cầu dừng và thu hồi quyền
  const beat = async () => {
    if (finished) return;
    const [r] = await db.update(videoExports).set({ heartbeatAt: sql`now()`, progressPercent: progress }).where(mine).returning({ cancel: videoExports.cancelRequested });
    if (finished) return;
    if (!r) {
      const [other] = await db.select({ id: videoExports.id }).from(videoExports).where(eq(videoExports.id, row.id));
      control.interrupt(other ? 'superseded' : 'gone');
    } else if (r.cancel) control.interrupt('user');
    else if (!(await userMayTranslate(row.ownerId))) control.interrupt('revoked');
  };
  const stopBeat = startBeat(beat, opts.heartbeatMs ?? 2000);

  /** Trừ hạn mức, đặt hạn xóa và chuyển `completed` trong một giao dịch; worker chết trước đó thì hạn mức chưa bị trừ. */
  const finalize = async (bytes: number): Promise<boolean> =>
    withVideoLock(async (tx) => {
      const [cur] = await tx
        .select({ id: videoExports.id })
        .from(videoExports)
        .where(and(mine, eq(videoExports.cancelRequested, false)))
        .for('update');
      if (!cur) return false;
      if (bytes > (await roomFor(row, tx))) throw new VideoFailure('QUOTA_EXCEEDED');
      const { videoOutputRetainDays } = await getSettings(tx);
      const now = new Date();
      await tx
        .update(videoExports)
        .set({ status: 'completed', outputKey: key, outputBytes: bytes, progressPercent: 100, finishedAt: now, heartbeatAt: null, expiresAt: new Date(now.getTime() + videoOutputRetainDays * 24 * 3600_000) })
        .where(eq(videoExports.id, row.id));
      await addVideoUsed(row.ownerId, bytes, tx);
      await tx.update(videoJobs).set({ lastActivityAt: now, updatedAt: now }).where(eq(videoJobs.id, row.jobId));
      await recomputeSourceExpiry(row.jobId, tx);
      return true;
    });

  const renderOnce = async (dir: string): Promise<void> => {
    const [job] = await db.select().from(videoJobs).where(eq(videoJobs.id, row.jobId));
    if (!job) throw new JobGone();
    const media = job.media;
    if (!media || !job.sourceKey || job.sourceState !== 'ready') throw new VideoFailure('SOURCE_DELETED');
    if ((await (opts.freeBytes ?? defaultFreeBytes)(dir)) < job.fileSizeBytes + row.estimatedBytes + DISK_MARGIN) throw new VideoFailure('DISK_FULL');
    const source = path.join(dir, `source.${job.ext}`);
    try {
      await (opts.download ?? downloadObjectToFile)(job.sourceKey, source);
    } catch (e) {
      throw storageFailure(e);
    }
    control.checkpoint();
    const maxBytes = await roomFor(row);
    if (maxBytes < 1) throw new VideoFailure('QUOTA_EXCEEDED');
    const { width, height } = burnOutputSize(media);
    const style = parseStoredStyle(row.style);
    const outPath = path.join(dir, `out.${row.format}`);
    await log('info', 'exportStarted', { width, height, sec: Math.round(media.durationMs / 100) / 10 });
    await log('info', 'exportRendering');

    let handle: RenderHandle | null = null;
    const cancel = () => handle?.cancel();
    control.abort.signal.addEventListener('abort', cancel, { once: true });
    try {
      handle = spawn(
        {
          type: 'burn',
          cues: toAppliedCues(row.cues, style.display),
          style: toSceneStyle(style, width, height),
          source: {
            path: source,
            demuxer: demuxerOf(job.ext),
            audioIndex: media.audioIndex,
            fps: media.fps,
            durationMs: media.durationMs,
            hdr: media.hdr,
            matrix: media.matrix,
            copyAudio: COPY_AUDIO_CODECS.has(media.audioCodec),
          },
          maxrate: burnMaxrate(media),
          outPath,
          maxBytes,
          threads: videoThreads(),
          fontDir: FONT_DIR(),
        },
        {
          onProgress: (frame, total) => {
            progress = Math.max(progress, Math.min(95, 50 + Math.floor((frame / Math.max(1, total)) * 45)));
          },
          onWarning: (w) => void log('warn', w.code === 'CUE_SHRUNK' ? 'cueShrunk' : 'missingGlyph', w.params),
        },
        { stallMs: opts.stallMs ?? 120_000 },
      );
      if (control.abort.signal.aborted) handle.cancel();
      const out = await handle.done;
      control.checkpoint();
      if (!out.ok) throw new VideoFailure(FAILURES.has(out.code) ? (out.code as VideoErrorCode) : 'RENDER_FAILED', out.detail);

      progress = 95;
      await log('info', 'exportRendered', { mb: Math.round((out.bytes / 1048576) * 10) / 10 });
      await log('info', 'exportUploading');
      try {
        await (opts.upload ?? uploadFileMultipart)(key, outPath, 'video/mp4', {
          signal: control.abort.signal,
          onProgress: (sent, total) => {
            progress = Math.max(progress, 95 + Math.floor((sent / Math.max(1, total)) * 4));
          },
        });
      } catch (e) {
        control.checkpoint();
        throw storageFailure(e);
      }
      control.checkpoint();
      if (!(await finalize(out.bytes))) {
        await beat();
        control.checkpoint();
        throw new JobGone();
      }
      completed = true;
      finished = true;
    } finally {
      control.abort.signal.removeEventListener('abort', cancel);
      handle?.cancel();
    }
  };

  try {
    await beat();
    control.checkpoint();
    if (row.interruptions > 0) await log('info', 'resumed', { attempt: row.interruptions + 1 });
    await withTransientRetry(
      control,
      async () => {
        const dir = await makeVideoTempDir();
        try {
          await renderOnce(dir);
        } finally {
          await rm(dir, { recursive: true, force: true }).catch(() => undefined);
        }
      },
      {
        retry,
        onRetry: async (attempt, max, wait) => {
          progress = 50;
          await log('warn', 'retrying', { attempt, max, sec: Math.round(wait / 100) / 10 });
        },
      },
    );
    stopBeat();
    await log('info', 'exportCompleted');
  } catch (e) {
    stopBeat();
    if (completed) return;
    // lượt này còn giữ bản xuất không: nếu lượt khác đã nhận lại thì không đụng vào tệp và trạng thái của lượt đó
    await beat().catch(() => undefined);
    finished = true;
    // khóa riêng của lượt này: xóa được cả khi lượt khác đã nhận lại bản xuất
    await deleteObject(key).catch(() => undefined);
    if (control.superseded) return;
    if (e instanceof JobGone || control.gone) return;
    const stopped = e instanceof JobStopped || !!control.stopped;
    const code: VideoErrorCode | null = stopped ? (control.stopped === 'revoked' ? 'PERMISSION_REVOKED' : null) : e instanceof VideoFailure ? e.code : 'INTERNAL';
    if (!stopped && (!(e instanceof VideoFailure) || e.detail)) console.error(`[video-render] ${row.id} ${code}: ${e instanceof VideoFailure ? e.detail : e instanceof Error ? e.message : ''}`);
    await db.transaction(async (tx) => {
      await tx
        .update(videoExports)
        .set({ status: stopped ? 'stopped' : 'failed', errorCode: code, cancelRequested: false, heartbeatAt: null, finishedAt: new Date() })
        .where(mine);
      await recomputeSourceExpiry(row.jobId, tx as unknown as Db);
    });
    await appendVideoLog(row.jobId, stopped ? 'warn' : 'error', stopped ? 'stopped' : 'failed', stopped ? undefined : { reason: code! }, { exportId: row.id });
  } finally {
    stopBeat();
  }
}

export async function registerVideoRender(boss: PgBoss): Promise<void> {
  await boss.work<VideoRenderPayload>(QUEUES.videoRender, { localConcurrency: VIDEO_RENDER_LOCAL_CONCURRENCY }, async (jobs) => {
    for (const j of jobs) await runVideoRender(j.data.exportId);
  });
}
