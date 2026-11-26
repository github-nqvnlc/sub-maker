import { fork } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BurnTask, ChildMessage, RenderErrorCode, RenderTask } from './protocol';

/** Chạy tiến trình con dựng hình và theo dõi nó (research R4). Không chạm CSDL: phần nghiệp vụ ở jobs/render-overlay. */

export type RenderOutcome = { ok: true; bytes: number } | { ok: false; code: RenderErrorCode | 'RENDER_STALLED' | 'CANCELLED'; detail: string };

export type RenderHooks = {
  onProgress?: (frame: number, total: number) => void;
  onWarning?: (w: Extract<ChildMessage, { type: 'warning' }>) => void;
};

export type RenderHandle = { done: Promise<RenderOutcome>; cancel: () => void; pid: number | undefined };

export type SpawnRender<T extends RenderTask | BurnTask = RenderTask> = (task: T, hooks: RenderHooks, opts: { stallMs: number }) => RenderHandle;

/** Biến môi trường tối thiểu cho tiến trình con: KHÔNG có thông tin CSDL, MinIO hay khóa (Nguyên tắc II). */
const ENV_ALLOWED = ['PATH', 'Path', 'FFMPEG_PATH', 'TMPDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'SystemRoot', 'SYSTEMROOT', 'windir', 'LANG', 'LC_ALL', 'NODE_ENV'];
export function childEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: Record<string, string> = {};
  for (const k of ENV_ALLOWED) if (source[k] !== undefined) env[k] = source[k]!;
  return env as NodeJS.ProcessEnv;
}

const ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), 'main.ts');
const FINISH_STALL_MS = 10 * 60_000;

export const spawnRender: SpawnRender<RenderTask | BurnTask> = (task, hooks, opts) => {
  const child = fork(ENTRY, [], { execArgv: ['--import', 'tsx'], env: childEnv(), stdio: ['ignore', 'inherit', 'inherit', 'ipc'], serialization: 'advanced' });
  if (child.pid) {
    try {
      // Nhường CPU cho tiến trình voice/STT; ffmpeg là con của tiến trình này nên thừa hưởng (FR-041)
      os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
    } catch {
      /* không đổi được độ ưu tiên: vẫn chạy */
    }
  }

  let cancelled = false;
  let lastFrame = -1;
  let lastMove = Date.now();
  let framesDone = false;

  let killing = false;
  const kill = () => {
    if (killing) return;
    killing = true;
    if (child.connected) child.send({ type: 'cancel' }, () => undefined);
    const t = setTimeout(() => child.kill('SIGKILL'), 5000);
    t.unref?.();
    child.once('exit', () => clearTimeout(t));
  };

  const done = new Promise<RenderOutcome>((resolve) => {
    let settled = false;
    let stalled = false;
    const finish = (o: RenderOutcome) => {
      if (settled) return;
      settled = true;
      clearInterval(watch);
      resolve(o);
    };
    const watch = setInterval(
      () => {
        const limit = framesDone ? Math.max(opts.stallMs, FINISH_STALL_MS) : opts.stallMs;
        if (Date.now() - lastMove > limit) {
          stalled = true;
          kill();
        }
      },
      Math.max(50, Math.min(1000, opts.stallMs / 4)),
    );
    child.on('message', (m: ChildMessage) => {
      if (m.type === 'progress') {
        if (m.frame !== lastFrame) {
          lastFrame = m.frame;
          lastMove = Date.now();
        }
        framesDone = m.frame >= m.total;
        hooks.onProgress?.(m.frame, m.total);
      } else if (m.type === 'warning') hooks.onWarning?.(m);
      else if (m.type === 'done') finish({ ok: true, bytes: m.bytes });
      else finish({ ok: false, code: m.code, detail: m.detail });
    });
    child.on('error', (e) => finish({ ok: false, code: 'RENDER_FAILED', detail: e.message }));
    child.on('exit', (code, signal) => {
      if (cancelled) finish({ ok: false, code: 'CANCELLED', detail: '' });
      else if (stalled) finish({ ok: false, code: 'RENDER_STALLED', detail: '' });
      else finish({ ok: false, code: 'RENDER_FAILED', detail: `child exited ${code ?? signal}` });
    });
    child.send(task, (e) => {
      if (e) finish({ ok: false, code: 'RENDER_FAILED', detail: e.message });
    });
  });

  return {
    done,
    pid: child.pid,
    cancel: () => {
      cancelled = true;
      kill();
    },
  };
};
