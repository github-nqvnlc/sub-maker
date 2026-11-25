/**
 * Đo tốc độ xuất video overlay bằng BỘ DỰNG HÌNH THẬT (spec 005, T092, T094): cùng tiến trình con, bộ vẽ và tham số ffmpeg như khi người
 * dùng xuất, chỉ bỏ CSDL và kho lưu trữ. Chữ lấy từ tệp .srt, lặp lại cho đủ thời lượng.
 *
 *   npx tsx scripts/overlay-bench.ts <tệp.srt> [giây=60] [cảnh=cut,bounce,karaoke,blur,glow] [định dạng=mp4,webm,mov]
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG, type OverlayConfig, type OverlayFormat } from '../src/lib/overlay/config';
import { applyTiming } from '../src/lib/overlay/timing';
import { parseSrtCues } from '../src/lib/parsing/srt';
import { spawnRender } from '../src/worker/render/spawn-render';

const SCENES: Record<string, Partial<OverlayConfig>> = {
  cut: {},
  bounce: { enter: 'bounce', exit: 'slideDown', effectMs: 300 },
  karaoke: { sync: 'karaoke', wordEffect: 'active' },
  wipe: { sync: 'karaoke', wordEffect: 'wipe' },
  typewriter: { sync: 'word', wordEffect: 'typewriter' },
  // trường hợp nặng nhất: chuyển động suốt 600 ms đầu mỗi câu
  blur: { enter: 'blurIn', effectMs: 600 },
  glow: { enter: 'glow', effectMs: 600 },
  // rung suốt câu nên không khung nào được dùng lại
  shake: { enter: 'shake', shakeScope: 'all' },
};

const [srt, secArg = '60', sceneArg = 'cut,bounce,karaoke,blur,glow', formatArg = 'mp4,webm,mov'] = process.argv.slice(2);
if (!srt) {
  console.error('Thiếu tệp .srt');
  process.exit(1);
}
const seconds = Number(secArg);
const durationMs = seconds * 1000;

function loopedCues() {
  const base = parseSrtCues(readFileSync(srt!, 'utf8')).cues.filter((c) => c.speakable);
  const span = Math.max(...base.map((c) => c.endMs)) + 200;
  const all = [];
  for (let k = 0; k * span < durationMs; k++) {
    for (const c of base) all.push({ startMs: c.startMs + k * span, endMs: c.endMs + k * span, text: c.text, speakable: true });
  }
  return applyTiming({ fileCues: all, source: 'uploaded', voiceTimeline: null, voiceDurationMs: durationMs }).cues;
}

/** Bộ nhớ cao nhất của tiến trình con (chỉ đọc được trên Linux). */
function peakMb(pid: number | undefined): number | null {
  try {
    const m = /VmHWM:\s+(\d+) kB/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'));
    return m ? Math.round(Number(m[1]) / 1024) : null;
  } catch {
    return null;
  }
}

async function main() {
  const cues = loopedCues();
  const dir = mkdtempSync(path.join(os.tmpdir(), 'overlay-bench-'));
  console.log(`${cues.length} câu, ${seconds} giây, ${os.cpus().length} luồng, ${os.cpus()[0]?.model.trim()}`);
  try {
    for (const format of formatArg.split(',') as OverlayFormat[]) {
      for (const name of sceneArg.split(',')) {
        const scene = SCENES[name];
        if (!scene) throw new Error(`Không có cảnh ${name}`);
        const config: OverlayConfig = { ...structuredClone(DEFAULT_CONFIG), ...scene, format, background: format === 'mp4' ? 'green' : 'transparent' };
        const t0 = Date.now();
        let mem: number | null = null;
        const handle = spawnRender(
          { type: 'render', cues, config, durationMs, audioPath: null, outPath: path.join(dir, `out.${format}`), maxBytes: 8 * 1024 ** 3, threads: Math.max(1, Math.floor(os.cpus().length / 2)), fontDir: path.resolve('public/fonts/overlay') },
          { onProgress: () => (mem = peakMb(handle.pid) ?? mem) },
          { stallMs: 120_000 },
        );
        const r = await handle.done;
        const s = (Date.now() - t0) / 1000;
        if (!r.ok) console.log(`${format.padEnd(5)} ${name.padEnd(11)} LỖI ${r.code} ${r.detail}`);
        else console.log(`${format.padEnd(5)} ${name.padEnd(11)} ${s.toFixed(1)} s (${(seconds / s).toFixed(1)}× thời gian thực), ${(r.bytes / 1048576).toFixed(2)} MB${mem ? `, ${mem} MB bộ nhớ` : ''}`);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
