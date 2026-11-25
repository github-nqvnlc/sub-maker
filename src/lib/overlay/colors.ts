import { BACKGROUND_COLOR, type OverlayConfig } from './config';
import type { OverlayWarning } from './types';

/** Cảnh báo màu (FR-010, FR-011, research R15). Hàm thuần, dùng chung cho giao diện và máy chủ. */

type Rgb = { r: number; g: number; b: number };

export function parseHex(hex: string): Rgb {
  const n = Number.parseInt(hex.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function toHsv({ r, g, b }: Rgb): { h: number; s: number; v: number } {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = (g - b) / d;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h = (h * 60 + 360) % 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max / 255 };
}

function luminance({ r, g, b }: Rgb): number {
  const f = (c: number) => {
    const x = c / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

const HUE_TOLERANCE = 40;
const MIN_SATURATION = 0.25;
const MIN_VALUE = 0.25;
const DARK_LUMINANCE = 0.02;

/** Màu này có bị xóa cùng phông không. Nền trong suốt không bao giờ. */
export function isKeyedColor(hex: string, background: OverlayConfig['background']): boolean {
  if (background === 'transparent') return false;
  const rgb = parseHex(hex);
  if (background === 'black') return luminance(rgb) < DARK_LUMINANCE;
  const c = toHsv(rgb);
  const bg = toHsv(parseHex(BACKGROUND_COLOR[background]));
  const diff = Math.abs(c.h - bg.h);
  return Math.min(diff, 360 - diff) <= HUE_TOLERANCE && c.s >= MIN_SATURATION && c.v >= MIN_VALUE;
}

/** Màu nổi bật chỉ được dùng ở karaoke, hoặc khi câu phát sáng ở chế độ theo câu. */
export const usesHighlight = (c: Pick<OverlayConfig, 'sync' | 'enter'>): boolean => c.sync === 'karaoke' || (c.sync === 'cue' && c.enter === 'glow');

const SOFT_ENTERS: ReadonlySet<OverlayConfig['enter']> = new Set(['fade', 'slideUp', 'dropDown', 'blurIn', 'glitch', 'glow']);

/** Cấu hình có vùng bán trong suốt (hộp nền chưa đặc, bóng mờ, mờ dần, nhòe, phát sáng, tách màu). */
export function hasSoftEdge(c: OverlayConfig): boolean {
  if (c.box.enabled && c.box.opacity > 0 && c.box.opacity < 100) return true;
  if (c.shadow.enabled && c.shadow.blur > 0) return true;
  if (c.sync !== 'word' && SOFT_ENTERS.has(c.enter)) return true;
  return c.exit !== 'cut';
}

export function colorWarnings(c: OverlayConfig): OverlayWarning[] {
  const out: OverlayWarning[] = [];
  const check = (field: string, hex: string) => {
    if (isKeyedColor(hex, c.background)) out.push({ code: 'KEYED_COLOR', params: { field } });
  };
  check('text', c.text.color);
  if (c.stroke.enabled) check('stroke', c.stroke.color);
  if (c.box.enabled && c.box.opacity > 0) check('box', c.box.color);
  if (usesHighlight(c)) check('highlight', c.highlightColor);
  if ((c.background === 'green' || c.background === 'blue') && hasSoftEdge(c)) out.push({ code: 'SOFT_EDGE' });
  return out;
}
