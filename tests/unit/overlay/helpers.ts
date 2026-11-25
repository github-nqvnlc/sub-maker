import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createCanvas, GlobalFonts, type SKRSContext2D } from '@napi-rs/canvas';
import { DEFAULT_CONFIG, type OverlayConfig } from '@/lib/overlay/config';
import { createScene, drawFrame, measureWith, type Ctx2D, type Layer, type Scene } from '@/lib/overlay/draw';
import { allFontFiles, registeredName, type FontCoverage } from '@/lib/overlay/fonts';
import type { AppliedCue } from '@/lib/overlay/types';

/** Công cụ vẽ bằng @napi-rs/canvas cho kiểm thử bộ dựng hình (spec 005). */

const FONT_DIR = path.resolve(process.cwd(), 'public/fonts/overlay');
let ready = false;
export function registerFonts(): void {
  if (ready) return;
  for (const f of allFontFiles()) {
    if (!GlobalFonts.registerFromPath(path.join(FONT_DIR, f.file), registeredName(f.family), { weight: String(f.weight) })) throw new Error(`Không nạp được ${f.file}`);
  }
  ready = true;
}

export const coverage = (): FontCoverage => JSON.parse(readFileSync(path.join(FONT_DIR, 'coverage.json'), 'utf8')) as FontCoverage;

export const asCtx = (g: SKRSContext2D): Ctx2D => g as unknown as Ctx2D;

export function createLayer(width: number, height: number): Layer {
  const canvas = createCanvas(width, height);
  return { canvas, ctx: asCtx(canvas.getContext('2d')), width, height };
}

export function measure() {
  registerFonts();
  return measureWith(asCtx(createCanvas(8, 8).getContext('2d')));
}

export const config = (over: Partial<OverlayConfig> = {}): OverlayConfig => ({ ...structuredClone(DEFAULT_CONFIG), ...over });

export const cue = (over: Partial<AppliedCue> = {}): AppliedCue => ({
  i: 0,
  startMs: 1000,
  endMs: 3000,
  readEndMs: 3000,
  text: 'Xin chào các bạn',
  origin: 'file',
  ...over,
});

export type Frame = { data: Uint8ClampedArray; width: number; height: number; key: string | null };

export function sceneOf(c: OverlayConfig, cues: AppliedCue[]): Scene {
  return createScene({ config: c, cues, measure: measure(), createLayer });
}

/** Vẽ một khung và trả điểm ảnh RGBA (không nhân sẵn alpha). */
export function render(scene: Scene, tMs: number): Frame {
  const canvas = createCanvas(scene.width, scene.height);
  const g = canvas.getContext('2d');
  const key = drawFrame(asCtx(g), tMs, scene);
  return { data: g.getImageData(0, 0, scene.width, scene.height).data, width: scene.width, height: scene.height, key };
}

export const pixel = (f: Frame, x: number, y: number): [number, number, number, number] => {
  const o = (Math.round(y) * f.width + Math.round(x)) * 4;
  return [f.data[o]!, f.data[o + 1]!, f.data[o + 2]!, f.data[o + 3]!];
};

/** Hình chữ nhật bao các điểm ảnh thỏa điều kiện; null khi không có. */
export function boundsWhere(f: Frame, pred: (r: number, g: number, b: number, a: number) => boolean) {
  let x0 = f.width;
  let y0 = f.height;
  let x1 = -1;
  let y1 = -1;
  let count = 0;
  for (let y = 0; y < f.height; y++) {
    for (let x = 0; x < f.width; x++) {
      const o = (y * f.width + x) * 4;
      if (!pred(f.data[o]!, f.data[o + 1]!, f.data[o + 2]!, f.data[o + 3]!)) continue;
      count++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? null : { x0, y0, x1, y1, count, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

export const notGreen = (r: number, g: number, b: number) => !(r === 0 && g === 255 && b === 0);
export const isWhite = (r: number, g: number, b: number) => r > 250 && g > 250 && b > 250;

export function sameFrame(a: Frame, b: Frame): boolean {
  return Buffer.compare(Buffer.from(a.data.buffer, a.data.byteOffset, a.data.byteLength), Buffer.from(b.data.buffer, b.data.byteOffset, b.data.byteLength)) === 0;
}

/** Phụ đề mẫu 244 cue của dự án. */
export const sampleSrt = () => readFileSync(path.resolve(process.cwd(), 'docs/example/tham-quyen-2026.srt'), 'utf8');
