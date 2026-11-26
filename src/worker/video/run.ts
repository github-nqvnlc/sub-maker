import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm, statfs } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { vi } from '../../lib/i18n/vi';
import { backoffMs, type RetryPolicy } from '../pipeline/synthesize-segment';
import { sleep } from '../../lib/providers/adapters/shared';

/**
 * Phần dùng chung của các tiến trình video (spec 006): lỗi và thử lại, cờ điều khiển của một lượt chạy, thư mục tạm, và chạy ffmpeg
 * có theo dõi tiến độ, hủy được, ưu tiên CPU thấp.
 */
export type VideoErrorCode = keyof typeof vi.video.errors;

export class VideoFailure extends Error {
  constructor(
    public readonly code: VideoErrorCode,
    public readonly detail = '',
  ) {
    super(code);
    this.name = 'VideoFailure';
  }
}
/** Việc đã bị xóa, hoặc lượt chạy khác đã nhận lại. */
export class JobGone extends Error {}
/** Người dùng yêu cầu dừng hoặc quyền bị thu hồi. */
export class JobStopped extends Error {}

/** Lỗi tạm: thử lại tối đa 3 lần sau lần đầu (FR-051). Mọi mã khác là vĩnh viễn. */
export const TRANSIENT_VIDEO_ERRORS: ReadonlySet<VideoErrorCode> = new Set<VideoErrorCode>(['STORAGE_UNAVAILABLE', 'RENDER_FAILED', 'RENDER_STALLED']);
export const VIDEO_RETRY: RetryPolicy = { maxAttempts: 4, baseMs: 2000, maxMs: 30_000 };
/** Quá số lần gián đoạn này trong một lượt chạy thì báo lỗi thay vì chạy mãi. */
export const MAX_VIDEO_INTERRUPTIONS = 3;
/** ffmpeg dùng tối đa số luồng trừ 2, chừa chỗ cho web và các tiến trình khác. */
export const videoThreads = (): number => Math.max(1, os.cpus().length - 2);

/** Cờ của một lượt chạy: nhịp tim đặt, các bước kiểm giữa chừng. */
export class RunControl {
  gone = false;
  /** lượt chạy khác đã nhận lại việc này (worker bị treo quá hạn nhịp tim): không đụng vào dữ liệu của lượt đó */
  superseded = false;
  stopped: 'user' | 'revoked' | null = null;
  readonly abort = new AbortController();

  interrupt(reason: 'gone' | 'superseded' | 'user' | 'revoked'): void {
    if (reason === 'user' || reason === 'revoked') this.stopped ??= reason;
    else {
      this.gone = true;
      if (reason === 'superseded') this.superseded = true;
    }
    this.abort.abort();
  }

  checkpoint(): void {
    if (this.gone) throw new JobGone();
    if (this.stopped) throw new JobStopped();
  }
}

/** Chạy một nhịp ngay rồi lặp lại; trả hàm dừng. Lỗi tạm của CSDL bị bỏ qua (nhịp sau thử lại). */
export function startBeat(beat: () => Promise<void>, everyMs: number): () => void {
  let stopped = false;
  const timer = setInterval(() => {
    if (!stopped) void beat().catch(() => undefined);
  }, everyMs);
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

/** Thử `step` với số lần giới hạn cho lỗi tạm; chờ tăng dần, hủy được. */
export async function withTransientRetry<T>(
  control: RunControl,
  step: () => Promise<T>,
  opts: { retry: RetryPolicy; onRetry: (attempt: number, max: number, waitMs: number, failure: VideoFailure) => Promise<void> },
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    control.checkpoint();
    try {
      return await step();
    } catch (e) {
      control.checkpoint();
      if (e instanceof JobGone || e instanceof JobStopped) throw e;
      const failure = e instanceof VideoFailure ? e : new VideoFailure('INTERNAL', e instanceof Error ? e.message : '');
      if (!TRANSIENT_VIDEO_ERRORS.has(failure.code) || attempt >= opts.retry.maxAttempts) throw failure;
      const wait = backoffMs(attempt, opts.retry);
      await opts.onRetry(attempt, opts.retry.maxAttempts - 1, wait, failure);
      await sleep(wait, control.abort.signal).catch(() => undefined);
    }
  }
}

/** Lỗi khi đọc, ghi kho lưu tệp: lỗi tạm, trừ khi đĩa đầy. */
export function storageFailure(e: unknown): VideoFailure {
  if (e instanceof VideoFailure) return e;
  const err = e as NodeJS.ErrnoException;
  return new VideoFailure(err?.code === 'ENOSPC' ? 'DISK_FULL' : 'STORAGE_UNAVAILABLE', err?.message ?? '');
}

export async function defaultFreeBytes(dir: string): Promise<number> {
  const s = await statfs(dir);
  return Number(s.bavail) * Number(s.bsize);
}

// ---- Thư mục tạm --------------------------------------------------------------------------------

const TMP_PREFIX = 'submaker-video-';

export const makeVideoTempDir = (): Promise<string> => mkdtemp(path.join(os.tmpdir(), `${TMP_PREFIX}${process.pid}-`));

/** Dọn thư mục tạm của các lần chạy trước (worker khởi động lại). Thư mục của tiến trình khác còn sống được giữ. */
export async function cleanupStaleVideoTempDirs(): Promise<number> {
  let removed = 0;
  for (const name of await readdir(os.tmpdir()).catch(() => [] as string[])) {
    const m = new RegExp(`^${TMP_PREFIX}(\\d+)-`).exec(name);
    if (!m) continue;
    const pid = Number(m[1]);
    let alive = pid === process.pid;
    if (!alive) {
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

// ---- ffmpeg có theo dõi -------------------------------------------------------------------------

export type TrackedOptions = {
  signal: AbortSignal;
  /** không có tiến triển quá mức này thì dừng (RENDER_STALLED) */
  stallMs?: number;
  /** mốc đã xử lý xong, tính bằng mili-giây của đầu ra */
  onTime?: (ms: number) => void;
};

function classify(stderr: string): VideoErrorCode {
  if (/No space left on device|ENOSPC/i.test(stderr)) return 'DISK_FULL';
  if (/Invalid data found when processing input|moov atom not found|could not find codec parameters/i.test(stderr)) return 'SOURCE_UNREADABLE';
  return 'RENDER_FAILED';
}

/** Chạy ffmpeg (mảng tham số cố định, không qua shell), ưu tiên CPU thấp. Bị hủy qua `signal` thì ném `JobStopped`. */
export function runTrackedFfmpeg(args: string[], opts: TrackedOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    if (opts.signal.aborted) return reject(new JobStopped());
    const child = spawn(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-nostats', '-progress', 'pipe:1', ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    if (child.pid) {
      try {
        os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
      } catch {
        /* không đổi được độ ưu tiên: vẫn chạy */
      }
    }
    const err: Buffer[] = [];
    let last = -1;
    let lastMove = Date.now();
    let stalled = false;
    let pending = '';
    child.stdout.on('data', (c: Buffer) => {
      const lines = (pending + c.toString('utf8')).split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        const m = /^out_time_us=(\d+)/.exec(line);
        if (!m) continue;
        const ms = Math.floor(Number(m[1]) / 1000);
        if (ms !== last) {
          last = ms;
          lastMove = Date.now();
          opts.onTime?.(ms);
        }
      }
    });
    child.stderr.on('data', (c: Buffer) => {
      if (err.length < 64) err.push(c);
    });
    const kill = () => child.kill('SIGKILL');
    opts.signal.addEventListener('abort', kill, { once: true });
    const stallMs = opts.stallMs ?? 120_000;
    const watch = setInterval(
      () => {
        if (Date.now() - lastMove > stallMs) {
          stalled = true;
          kill();
        }
      },
      Math.max(50, Math.min(1000, stallMs / 4)),
    );
    const done = () => {
      clearInterval(watch);
      opts.signal.removeEventListener('abort', kill);
    };
    child.on('error', (e) => {
      done();
      reject(new VideoFailure('RENDER_FAILED', e.message));
    });
    child.on('close', (code) => {
      done();
      if (opts.signal.aborted) return reject(new JobStopped());
      if (stalled) return reject(new VideoFailure('RENDER_STALLED'));
      if (code === 0) return resolve();
      const detail = Buffer.concat(err).toString('utf8').slice(0, 500);
      reject(new VideoFailure(classify(detail), `ffmpeg ${code}: ${detail}`));
    });
  });
}
