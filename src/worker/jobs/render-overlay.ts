import { createReadStream } from 'node:fs';
import { mkdtemp, readdir, rm, statfs } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { and, eq, gt, inArray, lt, sql } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import { getDb, type Db } from '../../lib/db';
import { overlayAudios, overlayJobs, users, voices } from '../../lib/db/schema';
import type { vi } from '../../lib/i18n/vi';
import { deleteOverlayObject } from '../../lib/overlay/control';
import { framesToMs, frameCount } from '../../lib/overlay/frames';
import { appendOverlayLog, type OverlayLogKey, type OverlayLogLevel } from '../../lib/overlay/log';
import { sleep } from '../../lib/providers/adapters/shared';
import { getSettings } from '../../lib/settings';
import { downloadObjectToFile, headObject, putObjectStream } from '../../lib/storage/client';
import { storageKeys } from '../../lib/storage/keys';
import { QuotaExceededError, reserveBytes } from '../../lib/storage/quota';
import { backoffMs, type RetryPolicy } from '../pipeline/synthesize-segment';
import { QUEUES, type RenderOverlayPayload } from '../queues';
import { spawnRender, type RenderHandle, type SpawnRender } from '../render/spawn-render';

/**
 * Tiến trình xuất video overlay (spec 005, US1). Luồng:
 *   nhận việc (queued|interrupted → running, có khóa và giới hạn riêng) → kiểm nguồn, chỗ trống đĩa → tải âm thanh → tiến trình con
 *   dựng hình → ghi đối tượng vào khóa cố định → MỘT giao dịch trừ hạn mức và chuyển `completed` (research R11).
 * Lỗi tạm thời thử lại tối đa 3 lần với thời gian chờ tăng dần; lỗi vĩnh viễn không thử lại (FR-038).
 */

export type OverlayErrorCode = keyof typeof vi.overlay.errors;

export type RenderRunOptions = {
  retry?: Partial<RetryPolicy>;
  heartbeatMs?: number;
  admissionPollMs?: number;
  stallMs?: number;
  /** thay tiến trình con trong kiểm thử */
  spawnRender?: SpawnRender;
  /** kiểm chỗ trống đĩa (kiểm thử) */
  freeBytes?: (dir: string) => Promise<number>;
  /** ghi đối tượng (kiểm thử lỗi kho lưu trữ) */
  putObject?: typeof putObjectStream;
};

/** Thử lại tối đa 3 lần sau lần đầu. */
const RETRY: RetryPolicy = { maxAttempts: 4, baseMs: 2000, maxMs: 30_000 };
const TRANSIENT: ReadonlySet<OverlayErrorCode> = new Set<OverlayErrorCode>(['RENDER_FAILED', 'RENDER_STALLED', 'STORAGE_UNAVAILABLE']);
const CONTENT_TYPE = { mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm' } as const;
const FONT_DIR = () => path.resolve(process.cwd(), 'public/fonts/overlay');

class OverlayFailure extends Error {
  constructor(
    public readonly code: OverlayErrorCode,
    public readonly detail = '',
  ) {
    super(code);
    this.name = 'OverlayFailure';
  }
}
class JobGone extends Error {}
class JobStopped extends Error {}

type Job = typeof overlayJobs.$inferSelect;

/** Khóa tư vấn: đếm số đang chạy rồi mới nhận phải nguyên tử. */
const ADMISSION_LOCK = 727_006;
/** Việc đang chờ được coi là còn người xử lý khi vừa chạm nhịp tim (chọn việc tạo trước). */
const WAITING_FRESH_MS = 10_000;

async function tryClaim(jobId: string): Promise<{ row: Job } | { wait: number } | null> {
  const { maxConcurrentOverlayJobs } = await getSettings();
  return getDb().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${ADMISSION_LOCK})`);
    const [cur] = await tx
      .select({ status: overlayJobs.status, cancel: overlayJobs.cancelRequested, createdAt: overlayJobs.createdAt })
      .from(overlayJobs)
      .where(eq(overlayJobs.id, jobId));
    if (!cur || (cur.status !== 'queued' && cur.status !== 'interrupted') || cur.cancel) return null;
    const [c] = await tx.select({ n: sql<number>`count(*)::int` }).from(overlayJobs).where(eq(overlayJobs.status, 'running'));
    const [older] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(overlayJobs)
      .where(
        and(
          inArray(overlayJobs.status, ['queued', 'interrupted']),
          lt(overlayJobs.createdAt, cur.createdAt),
          gt(overlayJobs.heartbeatAt, sql`now() - (${WAITING_FRESH_MS} * interval '1 millisecond')`),
        ),
      );
    const slots = maxConcurrentOverlayJobs - (c?.n ?? 0);
    if (slots <= (older?.n ?? 0)) {
      await tx.update(overlayJobs).set({ heartbeatAt: sql`now()` }).where(eq(overlayJobs.id, jobId));
      return { wait: maxConcurrentOverlayJobs };
    }
    const [row] = await tx
      .update(overlayJobs)
      .set({
        status: 'running',
        attempt: sql`${overlayJobs.attempt} + 1`,
        heartbeatAt: sql`now()`,
        startedAt: sql`coalesce(${overlayJobs.startedAt}, now())`,
        progressPercent: 0,
        errorCode: null,
        finishedAt: null,
      })
      .where(eq(overlayJobs.id, jobId))
      .returning();
    return row ? { row } : null;
  });
}

async function claim(jobId: string, opts: RenderRunOptions): Promise<Job | null> {
  let announced = false;
  for (;;) {
    const r = await tryClaim(jobId);
    if (!r) return null;
    if ('row' in r) return r.row;
    if (!announced) {
      announced = true;
      await appendOverlayLog(jobId, 'info', 'waiting', { max: r.wait });
    }
    await sleep(opts.admissionPollMs ?? 2000);
  }
}

async function defaultFreeBytes(dir: string): Promise<number> {
  const s = await statfs(dir);
  return Number(s.bavail) * Number(s.bsize);
}

async function remainingQuota(ownerId: string): Promise<number> {
  const { userQuotaBytes } = await getSettings();
  const [u] = await getDb().select({ used: users.storageUsedBytes }).from(users).where(eq(users.id, ownerId));
  if (!u) throw new JobGone();
  return Math.max(0, userQuotaBytes - u.used);
}

const TMP_PREFIX = 'submaker-overlay-';
const tmpPrefix = () => path.join(os.tmpdir(), `${TMP_PREFIX}${process.pid}-`);

/** Dọn thư mục tạm của các lần chạy trước (worker khởi động lại). Thư mục của tiến trình khác còn sống được giữ. */
export async function cleanupStaleTempDirs(): Promise<number> {
  let removed = 0;
  for (const name of await readdir(os.tmpdir()).catch(() => [] as string[])) {
    const m = new RegExp(`^${TMP_PREFIX}(\\d+)-`).exec(name);
    if (!m) continue;
    const pid = Number(m[1]);
    let alive = false;
    if (pid !== process.pid) {
      try {
        process.kill(pid, 0);
        alive = true;
      } catch (e) {
        alive = (e as NodeJS.ErrnoException).code === 'EPERM';
      }
    }
    if (alive) continue;
    await rm(path.join(os.tmpdir(), name), { recursive: true, force: true }).catch(() => undefined);
    removed++;
  }
  return removed;
}

export async function runRenderOverlay(jobId: string, opts: RenderRunOptions = {}): Promise<void> {
  const db = getDb();
  const job = await claim(jobId, opts);
  if (!job) return; // đã xóa, đã dừng, hoặc worker khác đang chạy

  const retry: RetryPolicy = { ...RETRY, ...opts.retry };
  const spawn = opts.spawnRender ?? spawnRender;
  let gone = false;
  /** lượt chạy khác đã nhận lại job này (worker bị treo quá hạn nhịp tim): không đụng vào dữ liệu của lượt đó */
  let superseded = false;
  let finished = false;
  let stop = false;
  let sourceDeleted = false;
  let progress = 0;
  let handle: RenderHandle | null = null;
  const abort = new AbortController();

  /** Chỉ tác động khi job vẫn thuộc LƯỢT CHẠY này. */
  const mine = and(eq(overlayJobs.id, jobId), eq(overlayJobs.status, 'running'), eq(overlayJobs.attempt, job.attempt));

  const log = async (level: OverlayLogLevel, key: OverlayLogKey, params?: Record<string, string | number>) => {
    if (!gone) await appendOverlayLog(jobId, level, key, params);
  };
  const interrupt = () => {
    abort.abort();
    handle?.cancel();
  };

  // Nhịp tim: ghi tiến độ, phát hiện bị xóa, yêu cầu dừng và nguồn bị xóa
  const beat = async () => {
    if (finished) return;
    const [r] = await db
      .update(overlayJobs)
      .set({ heartbeatAt: sql`now()`, progressPercent: progress })
      .where(mine)
      .returning({ cancel: overlayJobs.cancelRequested, voiceId: overlayJobs.voiceId, audioId: overlayJobs.audioId, fileId: overlayJobs.subtitleFileId });
    if (finished) return;
    if (!r) {
      gone = true;
      const [other] = await db.select({ id: overlayJobs.id }).from(overlayJobs).where(eq(overlayJobs.id, jobId));
      superseded = !!other;
    }
    else if (r.cancel) stop = true;
    else if (!r.fileId || !(r.voiceId ?? r.audioId)) sourceDeleted = true;
    if (gone || stop || sourceDeleted) interrupt();
  };
  const hb = setInterval(() => void beat().catch(() => undefined), opts.heartbeatMs ?? 1000);
  hb.unref?.();

  const checkpoint = () => {
    if (gone) throw new JobGone();
    if (stop) throw new JobStopped();
    if (sourceDeleted) throw new OverlayFailure('SOURCE_DELETED');
  };

  const key = storageKeys.overlayVideo(job.ownerId, jobId, job.format);

  const renderOnce = async (): Promise<void> => {
    await beat();
    checkpoint();
    const dir = await mkdtemp(tmpPrefix());
    try {
      const free = await (opts.freeBytes ?? defaultFreeBytes)(dir);
      if (free < job.estimatedBytes * 1.2 + 64 * 1024 * 1024) throw new OverlayFailure('DISK_FULL');

      let audioPath: string | null = null;
      if (job.config.includeAudio) {
        const source = job.voiceId
          ? (await db.select({ key: voices.storageKey }).from(voices).where(eq(voices.id, job.voiceId)))[0]?.key
          : (await db.select({ key: overlayAudios.storageKey }).from(overlayAudios).where(eq(overlayAudios.id, job.audioId!)))[0]?.key;
        if (!source) throw new OverlayFailure('SOURCE_DELETED');
        audioPath = path.join(dir, 'voice.mp3');
        try {
          if (!(await headObject(source))) throw new OverlayFailure('AUDIO_UNREADABLE');
          await downloadObjectToFile(source, audioPath);
        } catch (e) {
          if (e instanceof OverlayFailure) throw e;
          throw new OverlayFailure('STORAGE_UNAVAILABLE', e instanceof Error ? e.message : '');
        }
      }
      checkpoint();

      const outPath = path.join(dir, `out.${job.format}`);
      const total = frameCount(job.durationMs);
      await log('info', 'rendering', { frames: total });
      handle = spawn(
        {
          type: 'render',
          cues: job.cues,
          config: job.config,
          durationMs: job.durationMs,
          audioPath,
          outPath,
          maxBytes: Math.max(1, await remainingQuota(job.ownerId)),
          threads: Math.max(1, Math.floor(os.cpus().length / 2)),
          fontDir: FONT_DIR(),
        },
        {
          // 95% cho phần dựng, phần còn lại cho lưu trữ
          onProgress: (frame, n) => {
            progress = Math.max(progress, Math.min(95, Math.floor((frame / Math.max(1, n)) * 95)));
          },
          onWarning: (w) => void (w.code === 'CUE_SHRUNK' ? log('warn', 'cueShrunk', w.params) : log('warn', 'missingGlyph', w.params)),
        },
        { stallMs: opts.stallMs ?? 60_000 },
      );
      if (abort.signal.aborted) handle.cancel();
      const out = await handle.done;
      handle = null;
      checkpoint();
      // `SOURCE_UNREADABLE` chỉ có ở gắn cứng phụ đề (dịch video)
      if (!out.ok) throw new OverlayFailure(out.code === 'CANCELLED' || out.code === 'SOURCE_UNREADABLE' ? 'RENDER_FAILED' : out.code, out.detail);
      await log('info', 'rendered', { mb: Math.round((out.bytes / 1048576) * 100) / 100 });

      // Ghi đối tượng trước, rồi MỘT giao dịch trừ hạn mức + hoàn tất: worker chết giữa chừng thì hạn mức chưa bị trừ
      await log('info', 'uploading');
      progress = 96;
      try {
        await (opts.putObject ?? putObjectStream)(key, createReadStream(outPath), out.bytes, CONTENT_TYPE[job.format]);
      } catch (e) {
        throw new OverlayFailure('STORAGE_UNAVAILABLE', e instanceof Error ? e.message : '');
      }
      checkpoint();
      try {
        const completed = await db.transaction(async (tx) => {
          const r = await tx
            .update(overlayJobs)
            .set({ status: 'completed', progressPercent: 100, outputStorageKey: key, outputSizeBytes: out.bytes, finishedAt: new Date(), errorCode: null })
            .where(and(mine, eq(overlayJobs.cancelRequested, false)))
            .returning({ id: overlayJobs.id });
          if (r.length === 0) return false;
          await reserveBytes(job.ownerId, out.bytes, { db: tx as unknown as Db });
          return true;
        });
        finished = completed;
        if (!completed) {
          await beat();
          checkpoint();
          throw new JobGone();
        }
      } catch (e) {
        if (e instanceof QuotaExceededError) throw new OverlayFailure('QUOTA_EXCEEDED');
        throw e;
      }
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  };

  try {
    const sec = Math.round(framesToMs(frameCount(job.durationMs)) / 100) / 10;
    if (job.interruptions > 0) await log('info', 'resumed', { attempt: job.interruptions + 1 });
    else await log('info', 'started', { width: job.width, height: job.height, sec });

    for (let attempt = 1; ; attempt++) {
      try {
        await renderOnce();
        break;
      } catch (e) {
        if (e instanceof JobGone || e instanceof JobStopped) throw e;
        const f = e instanceof OverlayFailure ? e : new OverlayFailure('INTERNAL', e instanceof Error ? e.message : '');
        if (f.detail) console.error(`[render-overlay] ${jobId} ${f.code}: ${f.detail}`);
        if (!TRANSIENT.has(f.code) || attempt >= retry.maxAttempts) throw f;
        const wait = backoffMs(attempt, retry);
        await log('warn', 'retrying', { attempt, max: retry.maxAttempts - 1, sec: Math.round(wait / 100) / 10 });
        progress = 0;
        await sleep(wait, abort.signal).catch(() => undefined);
        checkpoint();
      }
    }
    clearInterval(hb);
    await log('info', 'completed');
  } catch (e) {
    clearInterval(hb);
    if (superseded) return;
    await deleteOverlayObject({ id: jobId, ownerId: job.ownerId, format: job.format });
    if (e instanceof JobGone || gone) return; // Project/User/lần xuất đã bị xóa
    if (e instanceof JobStopped) {
      await db
        .update(overlayJobs)
        .set({ status: 'stopped', cancelRequested: false, finishedAt: new Date() })
        .where(mine);
      await log('warn', 'stopped');
      return;
    }
    const code: OverlayErrorCode = e instanceof OverlayFailure ? e.code : 'INTERNAL';
    if (!(e instanceof OverlayFailure)) console.error('[render-overlay] lỗi không mong đợi:', e instanceof Error ? e.message : e);
    await db
      .update(overlayJobs)
      .set({ status: 'failed', errorCode: code, cancelRequested: false, finishedAt: new Date() })
      .where(mine);
    await log('error', 'failed', { reason: code });
  } finally {
    clearInterval(hb);
  }
}

/** Bằng mức tối đa của cài đặt `maxConcurrentOverlayJobs`; giới hạn thật do bước nhận việc (research R12). */
export const OVERLAY_LOCAL_CONCURRENCY = 10;

export async function registerRenderOverlay(boss: PgBoss): Promise<void> {
  await cleanupStaleTempDirs();
  await boss.work<RenderOverlayPayload>(QUEUES.renderOverlay, { localConcurrency: OVERLAY_LOCAL_CONCURRENCY }, async (jobs) => {
    for (const j of jobs) await runRenderOverlay(j.data.jobId);
  });
}
