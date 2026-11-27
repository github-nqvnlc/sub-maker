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
    ['bóng xa', { shadow: { enabled: true, color: '#FF00FF', blur: 40, distance: 20, opacity: 100 }, position: { anchor: 'bottom', y: 100 } }],
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

describe('song ngữ (FR-026, FR-028, FR-029)', () => {
  const secondary = { size: 32, color: '#FF0000', opacity: 100 };
  const plain: Partial<SceneStyle> = { secondary, stroke: { enabled: false, color: '#000000', width: 1 } };
  const duo = (text: string, source: string, over: Partial<AppliedCue> = {}) => cue({ text, secondary: source, ...over });
  const secondWords = (sc: Scene, i: number) => sc.layoutOf(i).secondary!.lines.map((l) => l.segments.map((s) => s.text).join(' '));

  it('câu gốc nằm trên, bản dịch nằm dưới, cùng canh lề; cả cụm có tâm ở độ cao đã chọn', () => {
    for (const align of ['left', 'center', 'right'] as const) {
      const sc = scene(style(1920, 1080, { ...plain, align, position: { anchor: 'center', y: 50 } }), [duo('Xin chào các bạn', 'Hello everyone, nice to see you')]);
      const l = sc.layoutOf(0);
      const sec = l.secondary!;
      expect(sec.fontSize).toBe(32);
      expect(Math.max(...sec.lines.map((x) => x.baseline))).toBeLessThan(l.lines[0]!.baseline - l.fontSize * 0.5);
      expect(l.box.y + l.box.height / 2).toBeCloseTo(540, 0);
      const edge = (line: { x: number; width: number }) => (align === 'left' ? line.x : align === 'right' ? line.x + line.width : line.x + line.width / 2);
      expect(edge(sec.lines[0]!)).toBeCloseTo(edge(l.lines[0]!), 6);
      expect(l.box.width).toBeCloseTo(Math.max(sec.lines[0]!.width, l.lines[0]!.width), 6);
    }
  });

  it('không có câu thứ hai hoặc kiểu không khai báo dòng thứ hai: bố cục như một khối', () => {
    const one = scene(style(1920, 1080), [cue({ text: 'Xin chào' })]).layoutOf(0);
    expect(scene(style(1920, 1080, { secondary }), [cue({ text: 'Xin chào' })]).layoutOf(0)).toEqual(one);
    expect(scene(style(1920, 1080), [duo('Xin chào', 'Hello')]).layoutOf(0)).toEqual(one);
  });

  it.each([
    ['đáy', 100],
    ['đỉnh', 0],
  ])('cụm dài và cỡ lớn vẫn nằm trọn trong khung ở %s, hai khối thu nhỏ cùng tỉ lệ', (_name, y) => {
    const s = style(1920, 1080, { ...plain, font: { family: 'be-vietnam-pro', size: 96, weight: 700 }, secondary: { ...secondary, size: 96 }, position: { anchor: 'bottom', y } });
    const sc = scene(s, [duo(`${LONG} ${LONG} ${LONG}`, `${LONG} ${LONG} ${LONG}`)]);
    const l = sc.layoutOf(0);
    expect(l.shrunk).toBe(true);
    expect(l.secondary!.fontSize / l.fontSize).toBeCloseTo(1, 1);
    expect(l.box.y - l.bleed).toBeGreaterThanOrEqual(-0.5);
    expect(l.box.y + l.box.height + l.bleed).toBeLessThanOrEqual(1080.5);
    for (const line of [...l.lines, ...l.secondary!.lines]) {
      expect(line.x).toBeGreaterThanOrEqual(-0.5);
      expect(line.x + line.width).toBeLessThanOrEqual(1920.5);
    }
  });

  it('cách xuống dòng của cả hai khối không đổi theo k', () => {
    const cues = [duo(LONG, `${LONG} in the original language of the video`)];
    const base = scene(style(1920, 1080, plain), cues);
    for (const k of [0.25, 1 / 3, 0.5, 2]) {
      const other = scene(style(Math.round(1920 * k), Math.round(1080 * k), { ...plain, frame: base.style.frame, k }), cues);
      expect(lineWords(other, 0)).toEqual(lineWords(base, 0));
      expect(secondWords(other, 0)).toEqual(secondWords(base, 0));
      expect(other.layoutOf(0).secondary!.fontSize).toBeCloseTo(32 * k, 6);
    }
  });

  it('dòng gốc có màu và độ mờ riêng, vẽ phía trên bản dịch', () => {
    const cues = [duo('Xin chào các bạn', 'Hello everyone')];
    const full = draw(scene(style(960, 540, plain), cues), 2000);
    const red = boundsOf(full, 960, 540, (r, g, b, a) => a > 200 && r > 200 && g < 60 && b < 60)!;
    const white = boundsOf(full, 960, 540, (r, g, b, a) => a > 200 && r > 200 && g > 200 && b > 200)!;
    expect(red.y1).toBeLessThan(white.y0);
    const faded = draw(scene(style(960, 540, { ...plain, secondary: { ...secondary, opacity: 50 } }), cues), 2000);
    const alpha = maxAlpha(faded, 960, red);
    expect(alpha).toBeGreaterThan(110);
    expect(alpha).toBeLessThan(145);
    // bản dịch không bị mờ theo
    expect(maxAlpha(faded, 960, white)).toBeGreaterThan(240);
    expect(boundsOf(draw(scene(style(960, 540, { ...plain, secondary: { ...secondary, opacity: 0 } }), cues), 2000), 960, 540, (r, g, b, a) => a > 0 && r > 200 && g < 60 && b < 60)).toBeNull();
  });

  it('hiệu ứng theo từ chỉ áp cho khối chính', () => {
    const cues = [duo('một hai ba bốn năm sáu', 'one two three four five six', { startMs: 1000, endMs: 4000, readEndMs: 4000 })];
    const sc = scene(style(960, 540, { ...plain, sync: 'word', wordEffect: 'cut' }), cues);
    const isRed = (r: number, g: number, b: number, a: number) => a > 200 && r > 200 && g < 60 && b < 60;
    const isWhitePx = (r: number, g: number, b: number, a: number) => a > 200 && r > 200 && g > 200 && b > 200;
    const early = draw(sc, 1001);
    const late = draw(sc, 3999);
    expect(boundsOf(early, 960, 540, isRed)).toEqual(boundsOf(late, 960, 540, isRed));
    expect(boundsOf(early, 960, 540, isWhitePx)!.count).toBeLessThan(boundsOf(late, 960, 540, isWhitePx)!.count / 2);
  });
});

describe('bóng: khoảng cách và độ đậm (FR-028)', () => {
  const shadowed = (distance: number, opacity: number): Partial<SceneStyle> => ({
    stroke: { enabled: false, color: '#000000', width: 1 },
    shadow: { enabled: true, color: '#FF00FF', blur: 0, distance, opacity },
  });
  const isShadow = (r: number, g: number, b: number, a: number) => a > 20 && r > 200 && g < 60 && b > 200;
  const frameOf = (over: Partial<SceneStyle>) => draw(scene(style(1920, 1080, over), [cue({ text: 'HELLO' })]), 2000);

  it('khoảng cách đẩy bóng xuống đúng số điểm ảnh của khung chuẩn', () => {
    const near = boundsOf(frameOf(shadowed(8, 100)), 1920, 1080, isShadow)!;
    const far = boundsOf(frameOf(shadowed(20, 100)), 1920, 1080, isShadow)!;
    expect(far.y1 - near.y1).toBeGreaterThanOrEqual(10);
    expect(far.y1 - near.y1).toBeLessThanOrEqual(14);
  });

  it('độ đậm quyết định độ đục của bóng; 0 thì không thấy bóng', () => {
    const half = frameOf(shadowed(20, 50));
    const box = boundsOf(half, 1920, 1080, isShadow)!;
    const lowest = maxAlpha(half, 1920, { ...box, y0: box.y1 - 4 });
    expect(lowest).toBeGreaterThan(100);
    expect(lowest).toBeLessThan(150);
    expect(boundsOf(frameOf(shadowed(20, 0)), 1920, 1080, isShadow)).toBeNull();
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

/** Khung bao và số điểm ảnh thỏa điều kiện của dữ liệu RGBA (không nhân sẵn alpha khi vẽ trực tiếp). */
function boundsOf(data: Buffer, width: number, height: number, pred: (r: number, g: number, b: number, a: number) => boolean) {
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  let count = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const a = data[o + 3]!;
      // dữ liệu canvas nhân sẵn alpha: chia lại để so màu
      const un = (v: number) => (a === 0 ? 0 : Math.min(255, Math.round((v * 255) / a)));
      if (!pred(un(data[o]!), un(data[o + 1]!), un(data[o + 2]!), a)) continue;
      count++;
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
    }
  }
  return x1 < 0 ? null : { x0, y0, x1, y1, count };
}

function maxAlpha(data: Buffer, width: number, r: { x0: number; y0: number; x1: number; y1: number }): number {
  let max = 0;
  for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0; x <= r.x1; x++) max = Math.max(max, data[(y * width + x) * 4 + 3]!);
  return max;
}

function maxDiff(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  expect(b.length).toBe(a.length);
  let max = 0;
  for (let i = 0; i < a.length; i++) max = Math.max(max, Math.abs(a[i]! - b[i]!));
  return max;
}
