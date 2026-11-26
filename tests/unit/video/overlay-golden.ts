/**
 * Khung "vàng" của Video Overlay (spec 006, T014; FR-036): mã băm điểm ảnh của nhiều cấu hình mẫu, ghi TRƯỚC khi mở rộng bộ vẽ.
 * Kết quả phụ thuộc nền tảng (bộ vẽ chữ) nên lưu theo `process.platform`.
 *
 * Chỉ ghi lại khi cố ý đổi hình của Video Overlay (phải tăng ENGINE_VERSION):
 *   npx tsx tests/unit/video/overlay-golden.ts --write
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createCanvas, type Canvas } from '@napi-rs/canvas';
import type { OverlayConfig } from '@/lib/overlay/config';
import { drawFrame, type Scene } from '@/lib/overlay/draw';
import type { AppliedCue } from '@/lib/overlay/types';
import { asCtx, config, cue, sceneOf } from '../overlay/helpers';

export const GOLDEN_FILE = path.resolve(process.cwd(), 'tests/fixtures/overlay-golden.json');

export const GOLDEN_CUES: AppliedCue[] = [
  cue({ i: 0, startMs: 1000, endMs: 3000, readEndMs: 2800, text: 'Hôm nay chúng ta cùng học cách dựng một đoạn phim ngắn có phụ đề thật rõ ràng.' }),
  cue({ i: 1, startMs: 3200, endMs: 4200, readEndMs: 4200, text: 'Tuyệt vời quá!' }),
  cue({ i: 2, startMs: 4500, endMs: 6000, readEndMs: 6000, text: Array(60).fill('phượng').join(' ') }),
];

const soft: Partial<OverlayConfig> = {
  stroke: { enabled: true, color: '#101010', width: 8 },
  shadow: { enabled: true, color: '#000000', blur: 14 },
  box: { enabled: true, color: '#1E40FF', radius: 28, opacity: 60 },
};

export const GOLDEN_CONFIGS: Record<string, Partial<OverlayConfig>> = {
  default: {},
  landscape: { aspect: '16:9', enter: 'bounce', exit: 'fade', effectMs: 300 },
  square: { ...soft, aspect: '1:1', align: 'left', position: { anchor: 'top', y: 18 }, maxWidthPct: 60 },
  right: { align: 'right', font: { family: 'roboto', size: 96, weight: 400 }, position: { anchor: 'center', y: 50 } },
  karaoke: { ...soft, background: 'transparent', format: 'mov', sync: 'karaoke', wordEffect: 'active', intensity: 'high' },
  wipe: { sync: 'karaoke', wordEffect: 'wipe', enter: 'fade' },
  typewriter: { sync: 'word', wordEffect: 'typewriter' },
  wordPop: { sync: 'word', wordEffect: 'pop', intensity: 'high', exit: 'slideDown' },
  pop: { enter: 'pop', intensity: 'high' },
  fade: { enter: 'fade', exit: 'fade' },
  slideUp: { enter: 'slideUp', exit: 'slideDown', effectMs: 400 },
  slideLeft: { enter: 'slideLeft' },
  slideRight: { enter: 'slideRight' },
  dropDown: { enter: 'dropDown', effectMs: 500 },
  blurIn: { enter: 'blurIn', effectMs: 600 },
  glitch: { enter: 'glitch' },
  glow: { enter: 'glow', effectMs: 600, background: 'black' },
  flip: { enter: 'flip3d', effectMs: 500, background: 'blue' },
  shake: { enter: 'shake', shakeScope: 'all', intensity: 'high' },
};

export const GOLDEN_TIMES = [0, 1000, 1017, 1050, 1120, 1250, 1900, 2850, 2990, 3220, 3300, 4180, 4600, 5990];

/** Một canvas dùng lại cho mỗi kích thước: tạo mới mỗi khung làm cạn bộ nhớ trước khi bộ gom rác kịp chạy. */
const canvases = new Map<string, Canvas>();

export function frameHash(scene: Scene, tMs: number): string {
  const size = `${scene.width}x${scene.height}`;
  let canvas = canvases.get(size);
  if (!canvas) canvases.set(size, (canvas = createCanvas(scene.width, scene.height)));
  drawFrame(asCtx(canvas.getContext('2d')), tMs, scene);
  return createHash('sha256').update(canvas.data()).digest('hex').slice(0, 20);
}

/** Mã băm của mọi cấu hình; mỗi cấu hình dùng một cảnh, vẽ theo thứ tự thời gian như lúc xuất. */
export async function goldenHashes(names: string[] = Object.keys(GOLDEN_CONFIGS)): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const name of names) {
    const scene = sceneOf(config(GOLDEN_CONFIGS[name]), GOLDEN_CUES);
    const hashes: string[] = [];
    for (const t of GOLDEN_TIMES) {
      hashes.push(frameHash(scene, t));
      await new Promise((resolve) => setImmediate(resolve)); // nhường cho bộ gom rác giải phóng lớp tạm
    }
    out[name] = hashes;
  }
  return out;
}

export const readGolden = (): Record<string, Record<string, string[]>> =>
  existsSync(GOLDEN_FILE) ? (JSON.parse(readFileSync(GOLDEN_FILE, 'utf8')) as Record<string, Record<string, string[]>>) : {};

if (process.argv.includes('--write') && process.argv[1]?.replaceAll('\\', '/').endsWith('overlay-golden.ts')) {
  void goldenHashes().then((hashes) => {
    const all = readGolden();
    all[process.platform] = hashes;
    writeFileSync(GOLDEN_FILE, `${JSON.stringify(all, null, 1)}\n`);
    console.log(`Đã ghi ${Object.keys(hashes).length} cấu hình cho ${process.platform}`);
  });
}
