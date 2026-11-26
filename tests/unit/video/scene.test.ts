import { createCanvas } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import { canonicalFrame, DEFAULT_CONFIG, outputSize, overlaySceneStyle, type SceneStyle } from '@/lib/overlay/config';
import { createScene, drawFrame, sceneBand, type Scene } from '@/lib/overlay/draw';
import type { AppliedCue } from '@/lib/overlay/types';
import { asCtx, createLayer, cue, measure } from '../overlay/helpers';
import { GOLDEN_CONFIGS, goldenHashes, readGolden } from './overlay-golden';

/** Bộ vẽ mở rộng cho dịch video (spec 006, T014; contracts/render-and-media.md §1; FR-036). */

const LONG = 'Hôm nay chúng ta cùng học cách dựng một đoạn phim ngắn có phụ đề thật rõ ràng và dễ đọc trên điện thoại của bạn nhé';

const style = (width: number, height: number, over: Partial<SceneStyle> = {}): SceneStyle => ({
  ...overlaySceneStyle(structuredClone(DEFAULT_CONFIG)),
  ...canonicalFrame(width, height),
  background: 'transparent',
  ...over,
});

const scene = (s: SceneStyle, cues: AppliedCue[]): Scene => createScene({ style: s, cues, measure: measure(), createLayer });

const lineWords = (sc: Scene, i: number) => sc.layoutOf(i).lines.map((l) => l.segments.map((s) => s.text).join(' '));

describe('khung chuẩn và hệ số k', () => {
  it('canonicalFrame giữ tỉ lệ, cạnh ngắn 1080; outputSize trả đúng kích thước đích', () => {
    expect(canonicalFrame(1920, 1080)).toEqual({ frame: { width: 1920, height: 1080 }, k: 1 });
    expect(canonicalFrame(720, 1280)).toEqual({ frame: { width: 1080, height: 1920 }, k: 2 / 3 });
    for (const [w, h] of [[640, 360], [3840, 2160], [1000, 562], [854, 480], [2560, 1080], [1080, 1080]] as const) {
      const c = canonicalFrame(w, h);
      expect(Math.min(c.frame.width, c.frame.height)).toBeCloseTo(1080, 6);
      expect(outputSize({ ...c })).toEqual({ width: w, height: h });
    }
  });

  it('OverlayConfig đổi sang SceneStyle với k = 1 cho cùng điểm ảnh', async () => {
    const config = structuredClone(DEFAULT_CONFIG);
    const cues = [cue({ text: LONG })];
    const a = createScene({ config, cues, measure: measure(), createLayer });
    const b = createScene({ style: overlaySceneStyle(config), cues, measure: measure(), createLayer });
    expect(draw(a, 2000).equals(draw(b, 2000))).toBe(true);
  });

  it.each([
    ['16:9', 1920, 1080],
    ['9:16', 1080, 1920],
    ['lẻ', 1000, 562],
  ])('cách xuống dòng không đổi theo k (%s)', (_name, w, h) => {
    const texts = [LONG, 'Một hai ba bốn năm sáu bảy tám chín mười', `Xem ${'https://example.com/duong-dan-rat-dai-khong-co-khoang-trang-'.repeat(3)} nhé`];
    const cues = texts.map((text, i) => cue({ i, startMs: i * 3000, endMs: i * 3000 + 2000, readEndMs: i * 3000 + 2000, text }));
    const base = scene(style(w, h), cues);
    for (const k of [0.25, 1 / 3, 0.5, 2 / 3, 2, 3]) {
      const other = scene(style(Math.round(w * k), Math.round(h * k), { frame: base.style.frame, k }), cues);
      for (let i = 0; i < cues.length; i++) {
        expect(lineWords(other, i)).toEqual(lineWords(base, i));
        const [a, b] = [base.layoutOf(i), other.layoutOf(i)];
        const ratio = k / base.style.k;
        expect(b.fontSize).toBeCloseTo(a.fontSize * ratio, 6);
        expect(b.box.y).toBeCloseTo(a.box.y * ratio, 6);
        expect(b.box.width).toBeCloseTo(a.box.width * ratio, 6);
      }
    }
  });

  it('chữ vẽ ở k = 0,5 nằm đúng nửa tọa độ của k = 1', () => {
    const full = scene(style(1920, 1080), [cue({ text: 'Xin chào các bạn' })]);
    const half = scene(style(960, 540), [cue({ text: 'Xin chào các bạn' })]);
    const a = rowsOf(draw(full, 2000), full)!;
    const b = rowsOf(draw(half, 2000), half)!;
    expect(Math.abs(b.y0 - a.y0 / 2)).toBeLessThanOrEqual(2);
    expect(Math.abs(b.y1 - a.y1 / 2)).toBeLessThanOrEqual(2);
  });
});

describe('ngắt dòng bắt buộc', () => {
  it('\\n luôn ngắt dòng dù còn chỗ; thứ tự từ cho hiệu ứng theo từ không đổi', () => {
    const sc = scene(style(1920, 1080), [cue({ text: 'Dòng một\nDòng hai\n\nDòng ba' })]);
    expect(lineWords(sc, 0)).toEqual(['Dòng một', 'Dòng hai', 'Dòng ba']);
    expect(sc.layoutOf(0).lines.flatMap((l) => l.segments.map((s) => s.word))).toEqual([0, 1, 2, 3, 4, 5]);
    expect(sc.spansOf(0).map((s) => s.text)).toEqual(['Dòng', 'một', 'Dòng', 'hai', 'Dòng', 'ba']);
  });

  it('dòng dài hơn khung vẫn được xuống dòng tiếp trong từng đoạn', () => {
    const sc = scene(style(1080, 1920), [cue({ text: `${LONG}\nHết` })]);
    const lines = lineWords(sc, 0);
    expect(lines.length).toBeGreaterThan(2);
    expect(lines.at(-1)).toBe('Hết');
  });
});

describe('sceneBand', () => {
  const cues = [
    cue({ i: 0, startMs: 0, endMs: 900, readEndMs: 900, text: 'Cảm ơn bạn rất nhiều!' }),
    cue({ i: 1, startMs: 1000, endMs: 2200, readEndMs: 2200, text: `Dòng trên\n${'phượng '.repeat(8).trim()}` }),
  ];
  const decorated: Partial<SceneStyle> = {
    stroke: { enabled: true, color: '#000000', width: 10 },
    shadow: { enabled: true, color: '#FF00FF', blur: 40 },
    box: { enabled: true, color: '#0000FF', radius: 40, opacity: 70 },
  };
  const variants: Array<[string, Partial<SceneStyle>]> = [
    ['mặc định', {}],
    ['trang trí', decorated],
    ['bung ra', { ...decorated, enter: 'bounce', intensity: 'high', effectMs: 400 }],
    ['phóng', { enter: 'pop', intensity: 'high', effectMs: 400 }],
    ['trượt lên rồi xuống', { enter: 'slideUp', exit: 'slideDown', effectMs: 400 }],
    ['rơi', { enter: 'dropDown', effectMs: 500 }],
    ['rung', { enter: 'shake', shakeScope: 'all', intensity: 'high' }],
    ['phát sáng', { enter: 'glow', effectMs: 600 }],
    ['nhòe', { enter: 'blurIn', effectMs: 600 }],
    ['giật', { enter: 'glitch' }],
    ['karaoke', { sync: 'karaoke', wordEffect: 'active', intensity: 'high' }],
    ['từ nảy', { sync: 'word', wordEffect: 'pop', intensity: 'high' }],
    ['trên cùng', { ...decorated, position: { anchor: 'top', y: 0 } }],
    ['dưới cùng', { ...decorated, position: { anchor: 'bottom', y: 100 }, enter: 'slideUp', effectMs: 400 }],
  ];

  it.each(variants)('không điểm ảnh nào ngoài dải (%s)', async (_name, over) => {
    const sc = scene(style(640, 360, over), cues);
    const band = sceneBand(sc);
    expect(band.y % 2).toBe(0);
    expect(band.height % 2).toBe(0);
    expect(band.y).toBeGreaterThanOrEqual(0);
    expect(band.y + band.height).toBeLessThanOrEqual(sc.height);
    const canvas = createCanvas(sc.width, sc.height);
    const g = canvas.getContext('2d');
    for (let t = 0; t <= 2300; t += 33) {
      drawFrame(asCtx(g), t, sc);
      const rows = rowsOf(Buffer.from(canvas.data()), sc);
      if (rows) {
        expect(rows.y0, `t=${t}`).toBeGreaterThanOrEqual(band.y);
        expect(rows.y1, `t=${t}`).toBeLessThan(band.y + band.height);
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
  }, 30_000);

  it('dải hẹp hơn khung khi chữ ở đáy; cả khung khi chữ chiếm quá 60%', () => {
    const small = sceneBand(scene(style(1920, 1080), [cue({ text: 'Ngắn' })]));
    expect(small.height).toBeLessThan(1080 * 0.4);
    expect(small.y).toBeGreaterThan(1080 * 0.4);
    const tall = scene(style(1920, 1080, { font: { family: 'be-vietnam-pro', size: 160, weight: 700 } }), [cue({ text: Array(40).fill('phượng').join(' ') })]);
    expect(sceneBand(tall)).toEqual({ y: 0, height: 1080 });
  });

  it('không có câu nào: dải tối thiểu', () => {
    expect(sceneBand(scene(style(640, 360), []))).toEqual({ y: 0, height: 2 });
  });

  it('vẽ với gốc dịch xuống đầu dải cho đúng phần tương ứng của khung đầy đủ', () => {
    const sc = scene(style(640, 360, { ...decorated, enter: 'bounce', effectMs: 400 }), cues);
    const band = sceneBand(sc);
    const full = createCanvas(sc.width, sc.height);
    const strip = createCanvas(sc.width, band.height);
    for (const t of [10, 200, 800, 1100, 1600]) {
      drawFrame(asCtx(full.getContext('2d')), t, sc);
      drawFrame(asCtx(strip.getContext('2d')), t, sc, { x: 0, y: band.y });
      const part = full.getContext('2d').getImageData(0, band.y, sc.width, band.height).data;
      const got = strip.getContext('2d').getImageData(0, 0, sc.width, band.height).data;
      expect(maxDiff(part, got), `t=${t}`).toBeLessThanOrEqual(2);
    }
  });
});

describe('Video Overlay không đổi (spec 005)', () => {
  it('mọi cấu hình mẫu vẽ ra đúng từng điểm ảnh như trước khi mở rộng', async () => {
    const golden = readGolden()[process.platform];
    expect(golden, `chưa có khung vàng cho ${process.platform}: chạy overlay-golden.ts --write trên mã trước thay đổi`).toBeDefined();
    expect(await goldenHashes()).toEqual(golden);
    expect(Object.keys(golden!)).toEqual(Object.keys(GOLDEN_CONFIGS));
  }, 120_000);
});

// ---- tiện ích ------------------------------------------------------------------------------------

function draw(sc: Scene, t: number): Buffer {
  const canvas = createCanvas(sc.width, sc.height);
  drawFrame(asCtx(canvas.getContext('2d')), t, sc);
  return Buffer.from(canvas.data());
}

/** Hàng đầu và cuối có điểm ảnh không trong suốt; null khi khung trống. */
function rowsOf(data: Buffer, sc: Scene): { y0: number; y1: number } | null {
  let y0 = -1;
  let y1 = -1;
  for (let y = 0; y < sc.height; y++) {
    const row = y * sc.width * 4;
    for (let x = 0; x < sc.width; x++) {
      if (data[row + x * 4 + 3]! !== 0) {
        if (y0 < 0) y0 = y;
        y1 = y;
        break;
      }
    }
  }
  return y0 < 0 ? null : { y0, y1 };
}

function maxDiff(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  expect(b.length).toBe(a.length);
  let max = 0;
  for (let i = 0; i < a.length; i++) max = Math.max(max, Math.abs(a[i]! - b[i]!));
  return max;
}
