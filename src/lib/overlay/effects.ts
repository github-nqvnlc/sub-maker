import type { Intensity, OverlayConfig } from './config';
import { graphemes, type CueLayout } from './layout';
import type { AppliedCue, WordSpan } from './types';
import { activeWordIndex } from './words';

/**
 * Hiệu ứng của câu và của từng từ (overlay-engine §5). Hàm thuần theo (thời điểm, cấu hình, bố cục): không Math.random, không đồng hồ.
 */

export type EffectState = {
  alpha: number;
  dx: number;
  dy: number;
  scaleX: number;
  scaleY: number;
  /** 0 = nét, 1 = nhòe nhất */
  blur: number;
  /** 0 = không phát sáng */
  glow: number;
  /** độ lệch (px) của hai bản tách màu; 0 = không tách */
  glitch: number;
  /** câu đứng yên: khung chỉ phụ thuộc câu và trạng thái từ */
  settled: boolean;
};

const IDENTITY: EffectState = { alpha: 1, dx: 0, dy: 0, scaleX: 1, scaleY: 1, blur: 0, glow: 0, glitch: 0, settled: true };

// ---- Đường cong ---------------------------------------------------------------------------------

const clamp01 = (p: number) => Math.min(1, Math.max(0, p));
export const easeOutCubic = (p: number) => 1 - (1 - clamp01(p)) ** 3;
const easeInOut = (p: number) => 0.5 - Math.cos(Math.PI * clamp01(p)) / 2;

/** Từ `from` vượt lên `peak` rồi về 1 (peak = 1 thì chỉ chậm dần về 1). */
export function overshoot(p: number, from: number, peak: number): number {
  const x = clamp01(p);
  if (peak <= 1) return from + (1 - from) * easeOutCubic(x);
  if (x < 0.6) return from + (peak - from) * easeOutCubic(x / 0.6);
  return peak + (1 - peak) * easeInOut((x - 0.6) / 0.4);
}

/** Nảy đàn hồi: vượt `peak`, hụt xuống một nửa mức vượt, rồi về 1. */
export function elastic(p: number, from: number, peak: number): number {
  const x = clamp01(p);
  const under = 1 - (peak - 1) / 2;
  if (x < 0.5) return from + (peak - from) * easeOutCubic(x / 0.5);
  if (x < 0.75) return peak + (under - peak) * easeInOut((x - 0.5) / 0.25);
  return under + (1 - under) * easeInOut((x - 0.75) / 0.25);
}

/** Rơi có dằn quán tính. */
function easeOutBounce(p: number): number {
  let x = clamp01(p);
  const n = 7.5625;
  const d = 2.75;
  if (x < 1 / d) return n * x * x;
  if (x < 2 / d) return n * (x -= 1.5 / d) * x + 0.75;
  if (x < 2.5 / d) return n * (x -= 2.25 / d) * x + 0.9375;
  return n * (x -= 2.625 / d) * x + 0.984375;
}

export const POP_PEAK: Record<Intensity, number> = { low: 1, medium: 1.02, high: 1.04 };
export const BOUNCE_PEAK: Record<Intensity, number> = { low: 1.03, medium: 1.05, high: 1.1 };
export const ACTIVE_SCALE: Record<Intensity, number> = { low: 1.15, medium: 1.18, high: 1.2 };
const SHAKE_PX: Record<Intensity, number> = { low: 2, medium: 4, high: 7 };
const REF_FONT = 72;
/** Biên độ rung (px) của một câu ở cỡ chữ đang vẽ. */
export const shakeAmplitude = (intensity: Intensity, fontSize: number): number => (SHAKE_PX[intensity] * fontSize) / REF_FONT;
/** Quãng trượt của hiệu ứng trượt lên / trượt xuống và rơi xuống, theo cỡ chữ. */
export const SLIDE_Y = 0.8;
export const DROP_Y = 1.2;
/** Giật tách màu chỉ kéo dài 0,1 giây (FR-021). */
export const GLITCH_MS = 100;
const STEP_MS = 1000 / 30;
const GLITCH_OFFSET = [10, -7, 4, -2];
const GLITCH_JITTER = [5, -4, 2, 0];

/** Giá trị giả ngẫu nhiên tất định trong [-1, 1]. */
function noise(a: number, b: number, salt: number): number {
  let h = (Math.imul(a + 1, 73856093) ^ Math.imul(b + 1, 19349663) ^ Math.imul(salt + 1, 83492791)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 2246822519) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 3266489917) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 0xffffffff * 2 - 1;
}

/** Câu cảm thán: kết thúc bằng dấu chấm than (có thể kèm dấu đóng ngoặc). */
export const isExclaim = (text: string): boolean => /[!！]["'”’)\]]*\s*$/u.test(text);

// ---- Thời lượng ---------------------------------------------------------------------------------

/** Thời lượng hiệu ứng vào và ra sau khi rút ngắn cho vừa câu (FR-027). */
export function effectDurations(c: Pick<OverlayConfig, 'enter' | 'exit' | 'effectMs'>, cueMs: number): { enter: number; exit: number } {
  let enter = c.enter === 'cut' || c.enter === 'shake' ? 0 : c.enter === 'glitch' ? GLITCH_MS : c.effectMs;
  let exit = c.exit === 'cut' ? 0 : c.effectMs;
  if (enter + exit > cueMs && enter + exit > 0) {
    const k = cueMs / (enter + exit);
    enter *= k;
    exit *= k;
  }
  return { enter, exit };
}

// ---- Hiệu ứng câu -------------------------------------------------------------------------------

type CueEffectConfig = Pick<OverlayConfig, 'enter' | 'exit' | 'effectMs' | 'intensity' | 'shakeScope'>;

export function cueEffect(c: CueEffectConfig, cue: AppliedCue, layout: CueLayout, frame: { width: number; height: number }, tMs: number): EffectState {
  const s: EffectState = { ...IDENTITY };
  const d = effectDurations(c, cue.endMs - cue.startMs);
  const el = tMs - cue.startMs;
  const fs = layout.fontSize;

  if (d.enter > 0 && el < d.enter) {
    s.settled = false;
    const p = clamp01(el / d.enter);
    switch (c.enter) {
      case 'fade':
        s.alpha = p;
        break;
      case 'pop':
        s.scaleX = s.scaleY = overshoot(p, 0.8, POP_PEAK[c.intensity]);
        break;
      case 'bounce':
        s.scaleX = s.scaleY = elastic(p, 0.8, BOUNCE_PEAK[c.intensity]);
        break;
      case 'slideUp':
        s.dy = SLIDE_Y * fs * (1 - easeOutCubic(p));
        s.alpha = easeOutCubic(p);
        break;
      case 'slideLeft':
        s.dx = -(layout.box.x + layout.box.width + layout.bleed) * (1 - easeOutCubic(p));
        break;
      case 'slideRight':
        s.dx = (frame.width - layout.box.x + layout.bleed) * (1 - easeOutCubic(p));
        break;
      case 'dropDown':
        s.dy = -DROP_Y * fs * (1 - easeOutBounce(p));
        s.alpha = clamp01(p * 3);
        break;
      case 'blurIn':
        s.blur = 1 - easeOutCubic(p);
        s.alpha = easeOutCubic(p);
        break;
      case 'glitch': {
        const step = Math.min(GLITCH_OFFSET.length - 1, Math.floor(el / STEP_MS));
        s.glitch = (GLITCH_OFFSET[step]! * fs) / REF_FONT;
        s.dx = (GLITCH_JITTER[step]! * fs) / REF_FONT;
        break;
      }
      case 'glow':
        s.glow = 1 - easeInOut(p);
        break;
      case 'flip3d':
        s.scaleY = Math.max(0.02, Math.cos((Math.PI / 2) * (1 - easeOutCubic(p))));
        break;
      default:
        break;
    }
  }

  if (c.enter === 'shake' && (c.shakeScope === 'all' || isExclaim(cue.text))) {
    s.settled = false;
    const step = Math.floor(el / STEP_MS);
    const amp = shakeAmplitude(c.intensity, fs);
    s.dx += noise(cue.i, step, 0) * amp;
    s.dy += noise(cue.i, step, 1) * amp;
  }

  const left = cue.endMs - tMs;
  if (d.exit > 0 && left < d.exit) {
    s.settled = false;
    const q = clamp01(1 - left / d.exit);
    if (c.exit === 'fade') s.alpha *= 1 - q;
    if (c.exit === 'slideDown') {
      s.dy += SLIDE_Y * fs * q * q;
      s.alpha *= 1 - q;
    }
  }
  return s;
}

// ---- Hiệu ứng từ --------------------------------------------------------------------------------

export type WordState = {
  visible: boolean;
  highlight: boolean;
  scale: number;
  /** số cụm ký tự đã hiện; null = cả từ */
  chars: number | null;
  /** phần từ đã được tô màu nổi bật, 0..1 */
  wipe: number;
};

/** Từ không có hiệu ứng nào. */
export const PLAIN: WordState = { visible: true, highlight: false, scale: 1, chars: null, wipe: 0 };
/** Thời gian từ đang đọc phóng lên cỡ nổi bật (ms). */
const ACTIVE_RAMP_MS = 80;

/** Trạng thái từng từ tại `tMs`; `key` = null khi đang chuyển động liên tục. */
export function wordStates(c: Pick<OverlayConfig, 'sync' | 'wordEffect' | 'effectMs' | 'intensity'>, cue: AppliedCue, spans: readonly WordSpan[], tMs: number): { states: WordState[]; key: string | null } {
  if (c.sync === 'cue') return { states: spans.map(() => PLAIN), key: 'c' };

  if (c.sync === 'word') {
    let moving = false;
    let count = 0;
    let typed = '';
    const states = spans.map((s, i): WordState => {
      if (tMs < s.startMs) return { ...PLAIN, visible: false };
      count++;
      if (c.wordEffect === 'typewriter') {
        const n = graphemes(s.text).length;
        const len = s.endMs - s.startMs;
        const shown = tMs >= s.endMs || len <= 0 ? n : Math.min(n, Math.floor(((tMs - s.startMs) / len) * n) + 1);
        if (shown < n) typed = `:${i}:${shown}`;
        return { ...PLAIN, chars: shown < n ? shown : null };
      }
      if (c.wordEffect === 'pop') {
        const next = spans[i + 1]?.startMs ?? cue.readEndMs;
        const dur = Math.min(c.effectMs, Math.max(1, next - s.startMs));
        const p = (tMs - s.startMs) / dur;
        if (p < 1) {
          moving = true;
          return { ...PLAIN, scale: overshoot(p, 0.6, BOUNCE_PEAK[c.intensity]) };
        }
      }
      return PLAIN;
    });
    return { states, key: moving ? null : `v${count}${typed}` };
  }

  // karaoke
  if (c.wordEffect === 'wipe') {
    let moving = false;
    let done = 0;
    const states = spans.map((s): WordState => {
      const len = s.endMs - s.startMs;
      const p = tMs >= cue.readEndMs || tMs >= s.endMs ? 1 : tMs < s.startMs || len <= 0 ? 0 : (tMs - s.startMs) / len;
      if (p >= 1) done++;
      else if (p > 0) moving = true;
      return { ...PLAIN, wipe: p };
    });
    return { states, key: moving ? null : `w${done}` };
  }
  const active = activeWordIndex(spans, tMs, cue.readEndMs);
  let moving = false;
  const states = spans.map((s, i): WordState => {
    if (i !== active) return PLAIN;
    const ramp = Math.min(ACTIVE_RAMP_MS, Math.max(1, (s.endMs - s.startMs) * 0.4));
    const p = (tMs - s.startMs) / ramp;
    if (p < 1) moving = true;
    return { ...PLAIN, highlight: true, scale: 1 + (ACTIVE_SCALE[c.intensity] - 1) * easeOutCubic(p) };
  });
  return { states, key: moving ? null : `a${active}` };
}
