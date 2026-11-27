import { BACKGROUND_COLOR, isTransparent, outputSize, overlaySceneStyle, type OverlayConfig, type SceneStyle } from './config';
import { BOUNCE_PEAK, cueEffect, DROP_Y, PLAIN, POP_PEAK, shakeAmplitude, SLIDE_Y, wordStates, type WordState } from './effects';
import { graphemes, layoutCue, SHADOW_DROP, type CueLayout, type Measure, type Segment } from './layout';
import { activeCueIndex } from './timing';
import type { AppliedCue, WordSpan } from './types';
import { wordSpans } from './words';

/**
 * Bộ vẽ khung của video overlay (overlay-engine §5) và của dịch video (spec 006, contracts/render-and-media.md §1): cùng mã cho khung
 * xem trước (canvas của trình duyệt) và tiến trình dựng hình (@napi-rs/canvas). Luôn vẽ ở KÍCH THƯỚC ĐÍCH của cảnh; không nhập DOM,
 * Node hay CSDL. Chữ chỉ đi vào fillText/strokeText (FR-046).
 */

/** Phần API Canvas 2D mà bộ vẽ dùng; cả hai môi trường đều có. */
export interface Ctx2D {
  font: string;
  textAlign: string;
  textBaseline: string;
  lineJoin: string;
  miterLimit: number;
  lineWidth: number;
  strokeStyle: unknown;
  fillStyle: unknown;
  globalAlpha: number;
  shadowColor: string;
  shadowBlur: number;
  shadowOffsetX: number;
  shadowOffsetY: number;
  imageSmoothingEnabled: boolean;
  imageSmoothingQuality: string;
  save(): void;
  restore(): void;
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  translate(x: number, y: number): void;
  scale(x: number, y: number): void;
  beginPath(): void;
  rect(x: number, y: number, w: number, h: number): void;
  roundRect(x: number, y: number, w: number, h: number, r: number): void;
  clip(): void;
  fill(): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  clearRect(x: number, y: number, w: number, h: number): void;
  fillText(text: string, x: number, y: number): void;
  strokeText(text: string, x: number, y: number): void;
  measureText(text: string): { width: number };
  drawImage(image: unknown, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number): void;
}

export type Layer = { canvas: unknown; ctx: Ctx2D; width: number; height: number };
export type CreateLayer = (width: number, height: number) => Layer;

type Block = { layer: Layer; x: number; y: number; w: number; h: number };

export type Scene = {
  /** kiểu cảnh trên khung chuẩn: bố cục tính từ đây */
  style: SceneStyle;
  /** cùng kiểu với mọi thông số điểm ảnh đã nhân `k`: dùng khi vẽ */
  config: SceneStyle;
  width: number;
  height: number;
  cues: readonly AppliedCue[];
  layoutOf(i: number): CueLayout;
  spansOf(i: number): WordSpan[];
  createLayer: CreateLayer;
  /** lớp tạm dùng lại giữa các khung; `key` là nội dung đang có; `faded` vẽ riêng dòng thứ hai khi nó trong suốt một phần */
  scratch: { main: { block: Block; key: string } | null; tintA: Block | null; tintB: Block | null; tintKey: string; glow: { block: Block; cue: number } | null; faded: Layer | null };
};

/** Giới hạn bộ nhớ đệm bố cục (video dài có hàng nghìn câu). */
const LAYOUT_CACHE = 64;

/** Thông số điểm ảnh của chữ ở khung đích. */
function paintStyle(s: SceneStyle): SceneStyle {
  if (s.k === 1) return s;
  return {
    ...s,
    stroke: { ...s.stroke, width: s.stroke.width * s.k },
    shadow: { ...s.shadow, blur: s.shadow.blur * s.k, ...(s.shadow.distance === undefined ? {} : { distance: s.shadow.distance * s.k }) },
    box: { ...s.box, radius: s.box.radius * s.k },
    ...(s.secondary ? { secondary: { ...s.secondary, size: s.secondary.size * s.k } } : {}),
  };
}

type SceneOptions = { cues: readonly AppliedCue[]; measure: Measure; createLayer: CreateLayer } & ({ style: SceneStyle; config?: never } | { config: OverlayConfig; style?: never });

export function createScene(opts: SceneOptions): Scene {
  const { cues, measure, createLayer } = opts;
  const style = opts.style ?? overlaySceneStyle(opts.config!);
  const layouts = new Map<number, CueLayout>();
  const spans = new Map<number, WordSpan[]>();
  const remember = <T>(map: Map<number, T>, i: number, make: () => T): T => {
    const hit = map.get(i);
    if (hit !== undefined) return hit;
    if (map.size >= LAYOUT_CACHE) map.delete(map.keys().next().value!);
    const v = make();
    map.set(i, v);
    return v;
  };
  return {
    style,
    config: paintStyle(style),
    ...outputSize(style),
    cues,
    layoutOf: (i) => remember(layouts, i, () => layoutCue(cues[i]!.text, style, measure, cues[i]!.secondary)),
    spansOf: (i) => remember(spans, i, () => wordSpans(cues[i]!)),
    createLayer,
    scratch: { main: null, tintA: null, tintB: null, tintKey: '', glow: null, faded: null },
  };
}

/** Hàm đo chữ dùng một ngữ cảnh canvas bất kỳ. */
export function measureWith(ctx: Pick<Ctx2D, 'font' | 'measureText'>): Measure {
  return (text, font) => {
    if (ctx.font !== font) ctx.font = font;
    return ctx.measureText(text).width;
  };
}

// ---- Vẽ khối chữ lên lớp tạm ---------------------------------------------------------------------

type Tint = { color: string } | null;

const clearShadow = (ctx: Ctx2D) => {
  ctx.shadowColor = 'rgba(0,0,0,0)';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
};

/** Chữ của một mẩu theo trạng thái từ (máy đánh chữ chỉ hiện một phần). Trả '' khi chưa hiện. */
function visibleText(seg: Segment, st: WordState, before: number): string {
  if (!st.visible) return '';
  if (st.chars === null) return seg.text;
  const g = graphemes(seg.text);
  return g.slice(0, Math.max(0, st.chars - before)).join('');
}

/** `#RRGGBB` kèm độ đục 0–1. */
const withAlpha = (hex: string, alpha: number): string => `rgba(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(',')},${alpha})`;

function composeText(ctx: Ctx2D, c: SceneStyle, layout: Pick<CueLayout, 'font' | 'fontSize' | 'lines'>, states: readonly WordState[], tint: Tint): void {
  ctx.font = layout.font;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;
  const strokeOn = c.stroke.enabled;
  const drop = c.shadow.distance ?? Math.round(layout.fontSize * SHADOW_DROP);
  const opacity = c.shadow.opacity ?? 100;
  const shadowColor = opacity >= 100 ? c.shadow.color : withAlpha(c.shadow.color, opacity / 100);

  type Item = { seg: Segment; y: number; text: string; st: WordState; wipeFrom: number; wipeTo: number };
  const items: Item[] = [];
  // cụm ký tự và bề rộng của các mẩu trước trong cùng một từ (từ bị ngắt thành nhiều mẩu)
  const charsBefore = new Map<number, number>();
  const widthBefore = new Map<number, number>();
  const wordWidth = new Map<number, number>();
  for (const line of layout.lines) for (const seg of line.segments) wordWidth.set(seg.word, (wordWidth.get(seg.word) ?? 0) + seg.width);
  for (const line of layout.lines) {
    for (const seg of line.segments) {
      const st = states[seg.word]!;
      const cb = charsBefore.get(seg.word) ?? 0;
      const wb = widthBefore.get(seg.word) ?? 0;
      const total = wordWidth.get(seg.word) ?? seg.width;
      const text = visibleText(seg, st, cb);
      if (text) items.push({ seg, y: line.baseline, text, st, wipeFrom: total > 0 ? wb / total : 0, wipeTo: total > 0 ? (wb + seg.width) / total : 1 });
      if (st.chars !== null) charsBefore.set(seg.word, cb + graphemes(seg.text).length);
      widthBefore.set(seg.word, wb + seg.width);
    }
  }
  // Từ đang phóng to vẽ sau cùng để nằm trên
  items.sort((a, b) => (a.st.scale === 1 ? 0 : 1) - (b.st.scale === 1 ? 0 : 1));

  const at = (it: Item, paint: () => void) => {
    if (it.st.scale === 1) return paint();
    const cx = it.seg.x + it.seg.width / 2;
    const cy = it.y - layout.fontSize * 0.35;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(it.st.scale, it.st.scale);
    ctx.translate(-cx, -cy);
    paint();
    ctx.restore();
  };
  const fillOf = (it: Item) => tint?.color ?? (it.st.highlight ? c.highlightColor : c.text.color);
  const strokeColor = tint?.color ?? c.stroke.color;

  if (c.shadow.enabled && opacity > 0 && !tint) {
    for (const it of items) {
      ctx.save();
      ctx.shadowColor = shadowColor;
      ctx.shadowBlur = c.shadow.blur;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = drop;
      at(it, () => {
        if (strokeOn) {
          ctx.lineWidth = c.stroke.width * 2;
          ctx.strokeStyle = strokeColor;
          ctx.strokeText(it.text, it.seg.x, it.y);
        } else {
          ctx.fillStyle = fillOf(it);
          ctx.fillText(it.text, it.seg.x, it.y);
        }
      });
      ctx.restore();
    }
  }
  clearShadow(ctx);
  // Hai lượt (chữ đứng yên trước, chữ phóng to sau) để viền của từ sau không đè lên thân chữ của từ trước
  for (const group of [items.filter((i) => i.st.scale === 1), items.filter((i) => i.st.scale !== 1)]) {
    if (strokeOn) {
      ctx.lineWidth = c.stroke.width * 2;
      ctx.strokeStyle = strokeColor;
      for (const it of group) at(it, () => ctx.strokeText(it.text, it.seg.x, it.y));
    }
    for (const it of group) {
      at(it, () => {
        ctx.fillStyle = fillOf(it);
        ctx.fillText(it.text, it.seg.x, it.y);
      });
      if (it.st.wipe > 0 && !tint) {
        const span = it.wipeTo - it.wipeFrom;
        const p = span > 0 ? Math.min(1, Math.max(0, (it.st.wipe - it.wipeFrom) / span)) : 1;
        if (p <= 0) continue;
        ctx.save();
        ctx.beginPath();
        // mép trái mở rộng để không cắt phần chữ nhô ra trước điểm đầu
        const lead = layout.fontSize * 0.2;
        ctx.rect(it.seg.x - lead, it.y - layout.fontSize * 1.2, lead + it.seg.width * p + (p >= 1 ? lead : 0), layout.fontSize * 1.8);
        ctx.clip();
        ctx.fillStyle = c.highlightColor;
        ctx.fillText(it.text, it.seg.x, it.y);
        ctx.restore();
      }
    }
  }
}

/** Hình chữ nhật của lớp chữ một câu: mọi điểm ảnh của câu (chưa tính chuyển động) nằm trong đó. */
function blockRect(scene: Scene, layout: CueLayout): { x: number; y: number; w: number; h: number } {
  // từ đang phóng to (tối đa 120%) vượt khối mỗi bên 10% bề rộng của nó; chỉ khối chính có từ phóng to
  const grow = scene.config.sync === 'cue' ? 0 : layout.lines.reduce((m, l) => l.segments.reduce((n, s) => Math.max(n, s.width), m), 0) * 0.1;
  const margin = Math.ceil(layout.bleed + layout.fontSize * 0.4 + grow + Math.max(2, 4 * scene.style.k));
  return {
    x: Math.floor(layout.box.x - margin),
    y: Math.floor(layout.box.y - margin),
    w: Math.ceil(layout.box.width + 2 * margin),
    h: Math.ceil(layout.box.height + 2 * margin),
  };
}

function composeBlock(scene: Scene, layout: CueLayout, states: readonly WordState[], reuse: Block | null, tint: Tint): Block {
  const c = scene.config;
  const { x, y, w, h } = blockRect(scene, layout);
  // Lớp phải đúng kích thước khối: lớp lớn hơn làm kết quả thu nhỏ (nhòe, lật) phụ thuộc câu đã vẽ trước đó, tức là phụ thuộc thứ tự vẽ
  const layer = reuse && reuse.layer.width === w && reuse.layer.height === h ? reuse.layer : scene.createLayer(w, h);
  const ctx = layer.ctx;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  clearShadow(ctx);
  ctx.clearRect(0, 0, layer.width, layer.height);
  ctx.save();
  ctx.translate(-x, -y);
  if (c.box.enabled && c.box.opacity > 0 && !tint) {
    ctx.globalAlpha = c.box.opacity / 100;
    ctx.fillStyle = c.box.color;
    ctx.beginPath();
    const r = Math.min(c.box.radius, layout.box.width / 2, layout.box.height / 2);
    ctx.roundRect(layout.box.x, layout.box.y, layout.box.width, layout.box.height, r);
    ctx.fill();
    ctx.globalAlpha = 1;
  }
  if (layout.secondary) composeSecondary(ctx, scene, layout.secondary, { x, y, w, h }, tint);
  composeText(ctx, c, layout, states, tint);
  ctx.restore();
  return { layer, x, y, w, h };
}

/**
 * Dòng thứ hai của cue song ngữ: màu và độ đục riêng, không có hiệu ứng theo từ. Trong suốt một phần thì vẽ đặc lên lớp riêng rồi mới
 * ghép, để viền không hiện xuyên qua thân chữ.
 */
function composeSecondary(ctx: Ctx2D, scene: Scene, sub: NonNullable<CueLayout['secondary']>, at: { x: number; y: number; w: number; h: number }, tint: Tint): void {
  const c = scene.config;
  const { color, opacity } = c.secondary!;
  if (opacity <= 0) return;
  const style: SceneStyle = { ...c, text: { color }, sync: 'cue' };
  const states = Array.from({ length: sub.wordCount }, () => PLAIN);
  if (opacity >= 100) return composeText(ctx, style, sub, states, tint);
  const reuse = scene.scratch.faded;
  const layer = reuse && reuse.width === at.w && reuse.height === at.h ? reuse : scene.createLayer(at.w, at.h);
  scene.scratch.faded = layer;
  const g = layer.ctx;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalAlpha = 1;
  clearShadow(g);
  g.clearRect(0, 0, at.w, at.h);
  g.save();
  g.translate(-at.x, -at.y);
  composeText(g, style, sub, states, tint);
  g.restore();
  ctx.save();
  ctx.globalAlpha = opacity / 100;
  ctx.drawImage(layer.canvas, 0, 0, at.w, at.h, at.x, at.y, at.w, at.h);
  ctx.restore();
}

// ---- Vẽ khung ------------------------------------------------------------------------------------

const BLUR_SCALE = 9;
const GLOW_PX = 48;
const TINT_A = '#FF0040';
const TINT_B = '#00A0FF';

/** Lề quanh khối chữ của quầng phát sáng. */
const glowPad = (scene: Scene): number => Math.ceil(GLOW_PX * 2 * scene.style.k);

/**
 * Quầng sáng của một câu ở mức mạnh nhất, tính MỘT lần mỗi câu rồi mờ dần bằng độ đục: tính bóng mờ lớn cho từng khung quá chậm
 * (đo được khoảng 87 ms/khung trong ảnh worker).
 */
function composeGlow(scene: Scene, i: number, layout: CueLayout, plain: readonly WordState[]): Block {
  const hit = scene.scratch.glow;
  if (hit?.cue === i) return hit.block;
  const text = composeBlock(scene, layout, plain, null, null);
  const pad = glowPad(scene);
  const layer = scene.createLayer(text.w + 2 * pad, text.h + 2 * pad);
  const g = layer.ctx;
  g.shadowColor = scene.config.highlightColor;
  g.shadowBlur = GLOW_PX * scene.style.k;
  for (let k = 0; k < 2; k++) g.drawImage(text.layer.canvas, 0, 0, text.w, text.h, pad, pad, text.w, text.h);
  clearShadow(g);
  const block: Block = { layer, x: text.x - pad, y: text.y - pad, w: layer.width, h: layer.height };
  scene.scratch.glow = { block, cue: i };
  return block;
}

function paintBackground(ctx: Ctx2D, scene: Scene, origin: Origin): void {
  ctx.setTransform(1, 0, 0, 1, -origin.x, -origin.y);
  ctx.globalAlpha = 1;
  clearShadow(ctx);
  ctx.clearRect(0, 0, scene.width, scene.height);
  const bg = scene.config.background;
  if (!isTransparent(scene.config) && bg !== 'transparent') {
    ctx.fillStyle = BACKGROUND_COLOR[bg];
    ctx.fillRect(0, 0, scene.width, scene.height);
  }
}

/** Điểm của khung đích nằm ở góc trên trái canvas (dựng hình dịch video chỉ vẽ dải chữ). */
export type Origin = { x: number; y: number };

/**
 * Vẽ một khung tại thời điểm `tMs`. Trả khóa khung: hai khung cùng khóa khác `null` thì giống hệt nhau; `null` khi đang chuyển động.
 */
export function drawFrame(ctx: Ctx2D, tMs: number, scene: Scene, origin: Origin = { x: 0, y: 0 }): string | null {
  paintBackground(ctx, scene, origin);
  const i = activeCueIndex(scene.cues, tMs);
  if (i < 0) return 'bg';

  const c = scene.config;
  const cue = scene.cues[i]!;
  const layout = scene.layoutOf(i);
  const { states, key: wordKey } = wordStates(c, cue, scene.spansOf(i), tMs);
  const fx = cueEffect(c, cue, layout, scene, tMs);
  if (fx.alpha <= 0) return fx.settled ? 'bg' : null;

  const blockKey = wordKey === null ? null : `${i}|${wordKey}`;
  let block: Block;
  if (blockKey !== null && scene.scratch.main?.key === blockKey) block = scene.scratch.main.block;
  else {
    block = composeBlock(scene, layout, states, scene.scratch.main?.block ?? null, null);
    scene.scratch.main = { block, key: blockKey ?? '' };
  }

  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.globalAlpha = fx.alpha;
  if (fx.scaleX !== 1 || fx.scaleY !== 1) {
    ctx.translate(layout.center.x, layout.center.y);
    ctx.scale(fx.scaleX, fx.scaleY);
    ctx.translate(-layout.center.x, -layout.center.y);
  }
  // Đứng yên thì vẽ ở tọa độ nguyên để chữ sắc nét
  const px = fx.settled ? block.x : block.x + fx.dx;
  const py = fx.settled ? block.y : block.y + fx.dy;
  const put = (b: Block, x: number, y: number) => ctx.drawImage(b.layer.canvas, 0, 0, b.w, b.h, x, y, b.w, b.h);

  if (fx.glitch !== 0) {
    const tintKey = blockKey ?? '';
    if (!scene.scratch.tintA || !scene.scratch.tintB || scene.scratch.tintKey !== tintKey || tintKey === '') {
      scene.scratch.tintA = composeBlock(scene, layout, states, scene.scratch.tintA, { color: TINT_A });
      scene.scratch.tintB = composeBlock(scene, layout, states, scene.scratch.tintB, { color: TINT_B });
      scene.scratch.tintKey = tintKey;
    }
    put(scene.scratch.tintA, px - fx.glitch, py);
    put(scene.scratch.tintB, px + fx.glitch, py);
  }
  if (fx.glow > 0) {
    const spans = scene.spansOf(i);
    const halo = composeGlow(scene, i, layout, wordStates({ ...c, sync: 'cue' }, cue, spans, tMs).states);
    ctx.save();
    ctx.globalAlpha = fx.alpha * fx.glow;
    put(halo, px + (halo.x - block.x), py + (halo.y - block.y));
    ctx.restore();
  }
  if (fx.blur > 0) {
    // Nhòe bằng cách thu nhỏ rồi phóng to (research R2): nhanh hơn nhiều so với bộ lọc blur và không phụ thuộc ctx.filter
    const k = 1 + BLUR_SCALE * fx.blur;
    const sw = Math.max(1, Math.ceil(block.w / k));
    const sh = Math.max(1, Math.ceil(block.h / k));
    const small = scene.createLayer(sw, sh);
    small.ctx.imageSmoothingEnabled = true;
    small.ctx.imageSmoothingQuality = 'high';
    small.ctx.drawImage(block.layer.canvas, 0, 0, block.w, block.h, 0, 0, sw, sh);
    ctx.drawImage(small.canvas, 0, 0, sw, sh, px, py, block.w, block.h);
  } else put(block, px, py);
  ctx.restore();

  return fx.settled && blockKey !== null ? blockKey : null;
}

// ---- Dải chữ (dịch video) ------------------------------------------------------------------------

/** Dải cao hơn phần này của khung thì vẽ cả khung (research R1). */
const BAND_MAX_SHARE = 0.6;

/** Quãng dọc mà một câu có thể chiếm trong suốt thời gian hiện, kể cả chuyển động của hiệu ứng. */
function verticalExtent(scene: Scene, layout: CueLayout): [number, number] {
  const c = scene.config;
  const rect = blockRect(scene, layout);
  let top = rect.y;
  let bottom = rect.y + rect.h;
  const fs = layout.fontSize;
  if (c.sync !== 'word') {
    if (c.enter === 'pop' || c.enter === 'bounce') {
      const peak = (c.enter === 'pop' ? POP_PEAK : BOUNCE_PEAK)[c.intensity];
      const cy = layout.center.y;
      top = Math.min(top, cy - (cy - rect.y) * peak);
      bottom = Math.max(bottom, cy + (rect.y + rect.h - cy) * peak);
    }
    if (c.enter === 'slideUp') bottom += SLIDE_Y * fs;
    if (c.enter === 'dropDown') top -= DROP_Y * fs;
    if (c.enter === 'glow') {
      top -= glowPad(scene);
      bottom += glowPad(scene);
    }
  }
  if (c.enter === 'shake') {
    top -= shakeAmplitude(c.intensity, fs);
    bottom += shakeAmplitude(c.intensity, fs);
  }
  if (c.exit === 'slideDown') bottom += SLIDE_Y * fs;
  // 2 px cho phần làm mịn khi vẽ ở tọa độ lẻ
  return [top - 2, bottom + 2];
}

/**
 * Dải ngang (tọa độ và chiều cao chẵn) chứa mọi điểm ảnh của mọi câu trong cảnh: tiến trình dựng hình chỉ vẽ và ghép dải này.
 * Dải lớn hơn 60% khung thì trả cả khung; không có câu nào thì trả dải tối thiểu.
 */
export function sceneBand(scene: Scene): { y: number; height: number } {
  let top = Number.POSITIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < scene.cues.length; i++) {
    const layout = scene.layoutOf(i);
    if (layout.lines.length === 0) continue;
    const [a, b] = verticalExtent(scene, layout);
    top = Math.min(top, a);
    bottom = Math.max(bottom, b);
  }
  if (bottom <= top) return { y: 0, height: 2 };
  const y = Math.max(0, Math.floor(top / 2) * 2);
  const end = Math.min(scene.height, Math.ceil(bottom / 2) * 2);
  if (end - y > scene.height * BAND_MAX_SHARE) return { y: 0, height: scene.height };
  return { y, height: end - y };
}
