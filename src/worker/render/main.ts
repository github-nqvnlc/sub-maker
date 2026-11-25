import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import { isTransparent, sizeOf } from '../../lib/overlay/config';
import { createScene, drawFrame, measureWith, type Ctx2D, type Layer } from '../../lib/overlay/draw';
import { fontFilesFor, missingChars, registeredName, type FontCoverage } from '../../lib/overlay/fonts';
import { frameCount, frameTimeMs } from '../../lib/overlay/frames';
import { encodeArgs } from './ffmpeg-args';
import type { ChildMessage, ParentMessage, RenderErrorCode, RenderTask } from './protocol';

/**
 * Tiến trình con dựng hình video overlay (spec 005, research R4): vẽ từng khung bằng @napi-rs/canvas với cùng bộ vẽ của khung xem
 * trước, đẩy RGBA thô sang ffmpeg. Không kết nối CSDL hay kho đối tượng, không nhận biến môi trường bí mật.
 * Worker cha điều khiển qua IPC; cha chết (mất kết nối) thì tự thoát.
 */

class RenderError extends Error {
  constructor(
    public readonly code: RenderErrorCode,
    detail: string,
  ) {
    super(detail);
    this.name = 'RenderError';
  }
}

const send = (m: ChildMessage) => {
  if (process.connected) process.send?.(m);
};

let ffmpeg: ChildProcess | null = null;
let cancelled = false;

function quit(code: number): never {
  ffmpeg?.kill('SIGKILL');
  process.exit(code);
}

const asCtx = (g: unknown): Ctx2D => g as Ctx2D;
function createLayer(width: number, height: number): Layer {
  const canvas = createCanvas(width, height);
  return { canvas, ctx: asCtx(canvas.getContext('2d')), width, height };
}

function classify(stderr: string): RenderErrorCode {
  if (/No space left on device|ENOSPC/i.test(stderr)) return 'DISK_FULL';
  if (/Invalid data found when processing input|Failed to find two consecutive MPEG audio frames|could not find codec parameters/i.test(stderr)) return 'AUDIO_UNREADABLE';
  return 'RENDER_FAILED';
}

async function render(task: RenderTask): Promise<number> {
  const { config } = task;
  for (const f of fontFilesFor(config.font.family)) {
    const ok = GlobalFonts.registerFromPath(path.join(task.fontDir, f.file), registeredName(f.family), { weight: String(f.weight) });
    if (!ok) throw new RenderError('RENDER_FAILED', `font ${f.file}`);
  }
  const { width, height } = sizeOf(config);
  const canvas = createCanvas(width, height);
  const g = canvas.getContext('2d');
  const scene = createScene({ config, cues: task.cues, measure: measureWith(asCtx(createCanvas(8, 8).getContext('2d'))), createLayer });

  // Cảnh báo cần đo chữ (không chặn xuất): worker ghi vào nhật ký
  const shrunk = task.cues.filter((_, i) => scene.layoutOf(i).shrunk).map((c) => c.i + 1);
  if (shrunk.length > 0) send({ type: 'warning', code: 'CUE_SHRUNK', params: { count: shrunk.length, cues: shrunk.slice(0, 10).join(', ') + (shrunk.length > 10 ? '…' : '') } });
  const coverage = JSON.parse(readFileSync(path.join(task.fontDir, 'coverage.json'), 'utf8')) as FontCoverage;
  const missing = new Set(task.cues.flatMap((c) => missingChars(c.text, config.font.family, config.font.weight, coverage)));
  if (missing.size > 0) send({ type: 'warning', code: 'MISSING_GLYPH', params: { chars: [...missing].slice(0, 20).join(' ') } });

  const total = frameCount(task.durationMs);
  const args = encodeArgs({ format: config.format, width, height, frames: total, audioPath: task.audioPath, outPath: task.outPath, threads: task.threads });
  const child = spawn(process.env.FFMPEG_PATH || 'ffmpeg', args, { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
  ffmpeg = child;
  const err: Buffer[] = [];
  child.stderr.on('data', (c: Buffer) => {
    if (err.length < 64) err.push(c);
  });
  const stdin = child.stdin;
  stdin.on('error', () => undefined); // ffmpeg thoát sớm được báo qua 'close'
  let closed = false;
  const exit = new Promise<number | null>((resolve) => {
    child.on('error', (e) => {
      err.push(Buffer.from(String(e.message)));
      closed = true;
      resolve(-1);
    });
    child.on('close', (code) => {
      closed = true;
      resolve(code);
    });
  });

  let frame = 0;
  const progress = setInterval(() => send({ type: 'progress', frame, total }), 500);
  let tooBig = false;
  const sizeGuard = setInterval(() => {
    stat(task.outPath)
      .then((s) => {
        if (s.size > task.maxBytes) {
          tooBig = true;
          child.kill('SIGKILL');
        }
      })
      .catch(() => undefined);
  }, 1000);

  try {
    const opaque = !isTransparent(config);
    let lastKey: string | null = null;
    let buf: Buffer | null = null;
    for (; frame < total && !closed && !cancelled; frame++) {
      const key = drawFrame(asCtx(g), frameTimeMs(frame), scene);
      // Khung trùng khóa với khung trước: gửi lại bộ đệm cũ, không đọc điểm ảnh (research R3)
      if (!buf || key === null || key !== lastKey) {
        // Nền đặc thì alpha luôn 255 nên dữ liệu nhân sẵn alpha trùng dữ liệu thẳng; nền trong suốt phải lấy dữ liệu chưa nhân
        buf = opaque ? Buffer.from(canvas.data()) : Buffer.from(g.getImageData(0, 0, width, height).data.buffer);
      }
      lastKey = key;
      if (!stdin.write(buf)) {
        await new Promise<void>((resolve) => {
          const done = () => {
            stdin.off('drain', done);
            child.off('close', done);
            resolve();
          };
          stdin.once('drain', done);
          child.once('close', done);
        });
      }
    }
    if (cancelled) quit(3);
    if (!closed) stdin.end();
    const code = await exit;
    if (tooBig) throw new RenderError('QUOTA_EXCEEDED', 'output larger than the remaining quota');
    if (code !== 0) {
      const detail = Buffer.concat(err).toString('utf8').slice(0, 500);
      throw new RenderError(classify(detail), `ffmpeg ${code}: ${detail}`);
    }
    const { size } = await stat(task.outPath);
    if (size > task.maxBytes) throw new RenderError('QUOTA_EXCEEDED', 'output larger than the remaining quota');
    send({ type: 'progress', frame: total, total });
    return size;
  } finally {
    clearInterval(progress);
    clearInterval(sizeGuard);
    if (!closed) child.kill('SIGKILL');
  }
}

process.on('disconnect', () => quit(4));
process.on('SIGTERM', () => quit(5));
process.on('message', (m: ParentMessage) => {
  if (m.type === 'cancel') {
    cancelled = true;
    quit(3);
  }
  render(m).then(
    (bytes) => {
      process.send?.({ type: 'done', bytes } satisfies ChildMessage, () => process.exit(0));
    },
    (e: unknown) => {
      const msg: ChildMessage =
        e instanceof RenderError
          ? { type: 'error', code: e.code, detail: e.message }
          : { type: 'error', code: (e as NodeJS.ErrnoException)?.code === 'ENOSPC' ? 'DISK_FULL' : 'RENDER_FAILED', detail: e instanceof Error ? e.message.slice(0, 500) : 'unknown' };
      process.send?.(msg, () => process.exit(1));
    },
  );
});
