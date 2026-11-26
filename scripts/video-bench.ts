/**
 * Cổng kiểm chứng của spec 006 (T002, T003; research R1, R15): đo gắn cứng phụ đề theo contracts/render-and-media.md §3.
 * Vẽ chữ bằng bộ vẽ hiện có (khung 16:9), CHỈ đẩy dải ngang chứa chữ (RGBA, alpha nhân sẵn) vào ffmpeg để ghép lên video nguồn giả.
 * Đồng thời kiểm ffmpeg của máy có đủ bộ lọc, bộ tách và bộ mã mà tính năng cần.
 *
 *   npx tsx scripts/video-bench.ts [giây1080p=60] [giây4K=20] [cảnh=cut,karaoke]
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import { DEFAULT_CONFIG, type OverlayConfig } from '../src/lib/overlay/config';
import { createScene, drawFrame, measureWith, type Ctx2D, type Layer } from '../src/lib/overlay/draw';
import { fontFilesFor, registeredName } from '../src/lib/overlay/fonts';
import type { AppliedCue } from '../src/lib/overlay/types';

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FPS = 30;
const THREADS = Math.max(1, os.cpus().length - 2);

const REQUIRED = {
  filters: ['zscale', 'tonemap', 'overlay'],
  demuxers: ['mov', 'matroska', 'avi', 'flv'],
  encoders: ['libx264', 'aac', 'libmp3lame'],
} as const;

const SCENES: Record<string, Partial<OverlayConfig>> = {
  /** chữ đứng yên: khung chỉ đổi khi đổi câu */
  cut: {},
  /** từ đang đọc phóng to và đổi màu: khung đổi liên tục */
  karaoke: { sync: 'karaoke', wordEffect: 'active' },
};

const SIZES = [
  { name: '1080p', width: 1920, height: 1080, maxrate: 8_000_000 },
  { name: '4K', width: 3840, height: 2160, maxrate: 24_000_000 },
] as const;

function listOf(kind: 'filters' | 'demuxers' | 'encoders'): Set<string> {
  const r = spawnSync(FFMPEG, ['-hide_banner', `-${kind}`], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const names = new Set<string>();
  for (const line of (r.stdout ?? '').split('\n')) {
    const cols = line.trim().split(/\s+/);
    // dạng "<cờ> <tên>[,<tên khác>] <mô tả>"
    if (cols.length >= 2) for (const n of cols[1]!.split(',')) names.add(n);
  }
  return names;
}

function checkFfmpeg(): boolean {
  const version = spawnSync(FFMPEG, ['-hide_banner', '-version'], { encoding: 'utf8' }).stdout?.split('\n')[0] ?? '?';
  console.log(version);
  let ok = true;
  for (const [kind, names] of Object.entries(REQUIRED) as Array<[keyof typeof REQUIRED, readonly string[]]>) {
    const have = listOf(kind);
    for (const n of names) {
      const found = have.has(n);
      ok &&= found;
      console.log(`${kind.padEnd(9)} ${n.padEnd(11)} ${found ? 'có' : 'THIẾU'}`);
    }
  }
  const help = spawnSync(FFMPEG, ['-hide_banner', '-h', 'filter=overlay'], { encoding: 'utf8' }).stdout ?? '';
  const premultiplied = /premultiplied/.test(help);
  console.log(`overlay=alpha=premultiplied ${premultiplied ? 'có' : 'THIẾU'}`);
  return ok && premultiplied;
}

function run(args: string[]): void {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: ['ignore', 'inherit', 'inherit'] });
  if (r.status !== 0) throw new Error(`ffmpeg ${r.status}`);
}

function makeSource(file: string, width: number, height: number, seconds: number): void {
  run([
    '-f', 'lavfi', '-i', `testsrc2=size=${width}x${height}:rate=${FPS}:duration=${seconds}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-shortest', file,
  ]);
}

/** Câu 2,5 giây liên tiếp, đủ dài để thành hai dòng. */
function makeCues(durationMs: number): AppliedCue[] {
  const texts = [
    'Hôm nay chúng ta cùng tìm hiểu cách dựng một đoạn phim ngắn có phụ đề rõ ràng',
    'Đầu tiên hãy chọn khung hình phù hợp với nền tảng bạn định đăng',
    'Sau đó chỉnh cỡ chữ để người xem đọc được trên màn hình điện thoại',
  ];
  const cues: AppliedCue[] = [];
  for (let i = 0; i * 2500 < durationMs; i++) {
    const startMs = i * 2500;
    const endMs = Math.min(durationMs, startMs + 2400);
    cues.push({ i, startMs, endMs, readEndMs: endMs, text: texts[i % texts.length]!, origin: 'file' });
  }
  return cues;
}

const asCtx = (g: unknown): Ctx2D => g as Ctx2D;
const createLayer = (width: number, height: number): Layer => {
  const canvas = createCanvas(width, height);
  return { canvas, ctx: asCtx(canvas.getContext('2d')), width, height };
};

async function burn(source: string, out: string, size: (typeof SIZES)[number], seconds: number, sceneName: string) {
  const config: OverlayConfig = { ...structuredClone(DEFAULT_CONFIG), ...SCENES[sceneName], aspect: '16:9', background: 'transparent', format: 'mov' };
  const base = createCanvas(1920, 1080);
  const g = base.getContext('2d');
  const cues = makeCues(seconds * 1000);
  const scene = createScene({ config, cues, measure: measureWith(asCtx(createCanvas(8, 8).getContext('2d'))), createLayer });

  // Dải chữ: hợp của mọi khối chữ cộng viền và quãng phóng to (contracts §1), làm tròn chẵn
  let top = 1080;
  let bottom = 0;
  for (let i = 0; i < cues.length; i++) {
    const l = scene.layoutOf(i);
    const pad = l.bleed + l.fontSize * 0.5;
    top = Math.min(top, l.box.y - pad);
    bottom = Math.max(bottom, l.box.y + l.box.height + pad);
  }
  const y0 = Math.max(0, Math.floor(top / 2) * 2);
  const h0 = Math.min(1080 - y0, Math.ceil((bottom - y0) / 2) * 2);
  const k = size.width / 1920;
  const bandY = Math.round(y0 * k);
  const bandH = Math.round(h0 * k);
  // 4K: bộ vẽ hiện có chỉ vẽ ở 1920×1080 nên phóng dải lên; bộ vẽ mở rộng (T025) sẽ vẽ thẳng ở cỡ đích
  const up = k === 1 ? null : createCanvas(size.width, bandH);
  const upCtx = up?.getContext('2d');

  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-protocol_whitelist', 'file', '-f', 'mov', '-i', source,
    '-protocol_whitelist', 'pipe', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${size.width}x${bandH}`, '-r', String(FPS), '-i', 'pipe:0',
    '-filter_complex',
    `[0:v:0]scale=trunc(iw*sar/2)*2:trunc(ih/2)*2,setsar=1[base];[1:v]scale=out_color_matrix=bt709:out_range=tv,format=yuva420p[sub];[base][sub]overlay=0:${bandY}:alpha=premultiplied:eof_action=pass[v]`,
    '-map', '[v]', '-map', '0:1', '-fps_mode', 'passthrough',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-maxrate', String(size.maxrate), '-bufsize', String(size.maxrate * 2), '-pix_fmt', 'yuv420p',
    '-c:a', 'copy', '-movflags', '+faststart', '-map_metadata', '-1', '-threads', String(THREADS), out,
  ];
  const t0 = Date.now();
  const child = spawn(FFMPEG, args, { stdio: ['pipe', 'ignore', 'inherit'] });
  const done = new Promise<number | null>((resolve) => child.on('close', resolve));
  child.stdin.on('error', () => undefined);

  const total = seconds * FPS;
  let lastKey: string | null = null;
  let buf: Buffer | null = null;
  let drawMs = 0;
  for (let frame = 0; frame < total && child.exitCode === null; frame++) {
    const d0 = performance.now();
    const key = drawFrame(asCtx(g), (frame * 1000) / FPS, scene);
    if (!buf || key === null || key !== lastKey) {
      if (up && upCtx) {
        upCtx.clearRect(0, 0, size.width, bandH);
        upCtx.drawImage(base, 0, y0, 1920, h0, 0, 0, size.width, bandH);
        buf = Buffer.from(up.data());
      } else buf = Buffer.from(base.data().subarray(y0 * 1920 * 4, (y0 + h0) * 1920 * 4));
    }
    lastKey = key;
    drawMs += performance.now() - d0;
    if (!child.stdin.write(buf)) await new Promise<void>((resolve) => child.stdin.once('drain', () => resolve()));
  }
  child.stdin.end();
  const code = await done;
  if (code !== 0) throw new Error(`ffmpeg ${code}`);
  const elapsed = (Date.now() - t0) / 1000;
  const speed = seconds / elapsed;
  console.log(
    `${size.name.padEnd(5)} ${sceneName.padEnd(8)} ${elapsed.toFixed(1)} s cho ${seconds} s = ${speed.toFixed(2)}× thời gian thực; vẽ chữ ${(drawMs / 1000).toFixed(1)} s; dải ${size.width}×${bandH}; ${(statSync(out).size / 1048576).toFixed(1)} MB`,
  );
  return speed;
}

async function main() {
  const [sec1080 = '60', sec4k = '20', sceneArg = 'cut,karaoke'] = process.argv.slice(2);
  const ok = checkFfmpeg();
  for (const f of fontFilesFor(DEFAULT_CONFIG.font.family)) {
    GlobalFonts.registerFromPath(path.resolve('public/fonts/overlay', f.file), registeredName(f.family), { weight: String(f.weight) });
  }
  const dir = mkdtempSync(path.join(os.tmpdir(), 'video-bench-'));
  console.log(`${os.cpus().length} luồng (${os.cpus()[0]?.model.trim()}), ffmpeg dùng ${THREADS} luồng`);
  let slowest1080 = Number.POSITIVE_INFINITY;
  try {
    for (const size of SIZES) {
      const seconds = Number(size.name === '1080p' ? sec1080 : sec4k);
      if (!seconds) continue;
      const source = path.join(dir, `${size.name}.mp4`);
      makeSource(source, size.width, size.height, seconds);
      for (const scene of sceneArg.split(',')) {
        if (!SCENES[scene]) throw new Error(`Không có cảnh ${scene}`);
        const speed = await burn(source, path.join(dir, `${size.name}-${scene}.mp4`), size, seconds, scene);
        if (size.name === '1080p') slowest1080 = Math.min(slowest1080, speed);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const passed = ok && slowest1080 >= 0.5;
  console.log(passed ? 'CỔNG: ĐẠT (đủ thành phần ffmpeg và 1080p ≥ 0,5× thời gian thực)' : 'CỔNG: KHÔNG ĐẠT');
  process.exit(passed ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
