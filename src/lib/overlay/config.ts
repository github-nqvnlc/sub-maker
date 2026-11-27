import { hasWeight, type FontFamily, type FontWeight } from './fonts';

/**
 * Cấu hình video overlay (overlay-engine §1). Dùng chung cho giao diện, API và tiến trình dựng hình.
 * Đổi hành vi nhìn thấy được của bộ dựng hình thì tăng ENGINE_VERSION.
 */
export const ENGINE_VERSION = 1;

export const ASPECTS = ['9:16', '16:9', '1:1'] as const;
export const BACKGROUNDS = ['green', 'blue', 'black', 'transparent'] as const;
export const FORMATS = ['mp4', 'mov', 'webm'] as const;
export const ANCHORS = ['bottom', 'center', 'top'] as const;
export const ALIGNS = ['left', 'center', 'right'] as const;
export const SYNCS = ['cue', 'word', 'karaoke'] as const;
export const ENTERS = ['cut', 'fade', 'pop', 'bounce', 'slideUp', 'slideLeft', 'slideRight', 'dropDown', 'blurIn', 'glitch', 'glow', 'flip3d', 'shake'] as const;
export const EXITS = ['cut', 'fade', 'slideDown'] as const;
export const INTENSITIES = ['low', 'medium', 'high'] as const;
export const WORD_EFFECTS = ['none', 'cut', 'pop', 'typewriter', 'active', 'wipe'] as const;
export const SHAKE_SCOPES = ['exclaim', 'all'] as const;

export type Aspect = (typeof ASPECTS)[number];
export type Background = (typeof BACKGROUNDS)[number];
export type OverlayFormat = (typeof FORMATS)[number];
export type Anchor = (typeof ANCHORS)[number];
export type Align = (typeof ALIGNS)[number];
export type Sync = (typeof SYNCS)[number];
export type Enter = (typeof ENTERS)[number];
export type Exit = (typeof EXITS)[number];
export type Intensity = (typeof INTENSITIES)[number];
export type WordEffect = (typeof WORD_EFFECTS)[number];
export type ShakeScope = (typeof SHAKE_SCOPES)[number];

export const SIZE_OF: Record<Aspect, { width: number; height: number }> = {
  '9:16': { width: 1080, height: 1920 },
  '16:9': { width: 1920, height: 1080 },
  '1:1': { width: 1080, height: 1080 },
};

export const BACKGROUND_COLOR: Record<Exclude<Background, 'transparent'>, string> = {
  green: '#00FF00',
  blue: '#0000FF',
  black: '#000000',
};

/** Chọn vị trí nhanh đặt độ cao (phần trăm chiều cao, tính theo tâm khối chữ). */
export const ANCHOR_Y: Record<Anchor, number> = { bottom: 82, center: 50, top: 18 };

/** Hiệu ứng từ hợp lệ theo chế độ; phần tử đầu là mặc định. */
export const WORD_EFFECTS_OF: Record<Sync, readonly WordEffect[]> = {
  cue: ['none'],
  word: ['cut', 'pop', 'typewriter'],
  karaoke: ['active', 'wipe'],
};

/** Định dạng hợp lệ theo nền; phần tử đầu là mặc định (FR-032). */
export const formatsOf = (background: Background): readonly OverlayFormat[] => (background === 'transparent' ? ['mov', 'webm'] : ['mp4']);

export const LIMITS = {
  fontSize: { min: 24, max: 160 },
  strokeWidth: { min: 1, max: 20 },
  shadowBlur: { min: 0, max: 40 },
  boxRadius: { min: 0, max: 60 },
  boxOpacity: { min: 0, max: 100 },
  y: { min: 0, max: 100 },
  maxWidthPct: { min: 40, max: 100 },
  effectMs: { min: 100, max: 600, step: 10 },
} as const;

export type OverlayConfig = {
  aspect: Aspect;
  background: Background;
  format: OverlayFormat;
  includeAudio: boolean;
  font: { family: FontFamily; size: number; weight: FontWeight };
  text: { color: string };
  stroke: { enabled: boolean; color: string; width: number };
  shadow: { enabled: boolean; color: string; blur: number };
  box: { enabled: boolean; color: string; radius: number; opacity: number };
  position: { anchor: Anchor; y: number };
  align: Align;
  maxWidthPct: number;
  sync: Sync;
  enter: Enter;
  wordEffect: WordEffect;
  exit: Exit;
  effectMs: number;
  intensity: Intensity;
  highlightColor: string;
  shakeScope: ShakeScope;
};

type Problem = { path: string; fix: (c: OverlayConfig) => void };

/** Các tổ hợp không hợp lệ và cách đưa về mặc định của chế độ (FR-028). */
function problems(c: OverlayConfig): Problem[] {
  const out: Problem[] = [];
  if (!formatsOf(c.background).includes(c.format)) {
    out.push({
      path: 'format',
      fix: (x) => {
        x.format = formatsOf(x.background)[0]!;
      },
    });
  }
  if (!hasWeight(c.font.family, c.font.weight)) {
    out.push({
      path: 'font.weight',
      fix: (x) => {
        x.font.weight = 700;
      },
    });
  }
  if (!WORD_EFFECTS_OF[c.sync].includes(c.wordEffect)) {
    out.push({
      path: 'wordEffect',
      fix: (x) => {
        x.wordEffect = WORD_EFFECTS_OF[x.sync][0]!;
      },
    });
  }
  // Chế độ theo từng từ: từng từ tự xuất hiện nên không có hiệu ứng vào của cả câu
  if (c.sync === 'word' && c.enter !== 'cut') {
    out.push({
      path: 'enter',
      fix: (x) => {
        x.enter = 'cut';
      },
    });
  }
  return out;
}

/** Tên các trường có tổ hợp không hợp lệ. */
export const configProblems = (c: OverlayConfig): string[] => problems(c).map((p) => p.path);

export const DEFAULT_CONFIG: OverlayConfig = {
  aspect: '9:16',
  background: 'green',
  format: 'mp4',
  includeAudio: true,
  font: { family: 'be-vietnam-pro', size: 72, weight: 700 },
  text: { color: '#FFFFFF' },
  stroke: { enabled: true, color: '#000000', width: 6 },
  shadow: { enabled: false, color: '#000000', blur: 8 },
  box: { enabled: false, color: '#000000', radius: 16, opacity: 100 },
  position: { anchor: 'bottom', y: ANCHOR_Y.bottom },
  align: 'center',
  maxWidthPct: 90,
  sync: 'cue',
  enter: 'cut',
  wordEffect: 'none',
  exit: 'cut',
  effectMs: 250,
  intensity: 'medium',
  highlightColor: '#FFE600',
  shakeScope: 'exclaim',
};

/** Đưa tổ hợp không hợp lệ về mặc định; trả cấu hình mới và tên các trường đã sửa. */
export function normalizeConfig(input: OverlayConfig): { config: OverlayConfig; changed: string[] } {
  const config = structuredClone(input);
  const changed: string[] = [];
  for (const p of problems(config)) {
    p.fix(config);
    changed.push(p.path);
  }
  return { config, changed };
}

/**
 * Đổi nền: chọn định dạng hợp lệ; sang phông đen mà viền đang ở màu đen mặc định thì tắt viền (viền sẽ biến mất khi hòa trộn, FR-010).
 */
export function applyBackground(input: OverlayConfig, background: Background): { config: OverlayConfig; changed: string[] } {
  const { config, changed } = normalizeConfig({ ...structuredClone(input), background });
  if (background === 'black' && config.stroke.enabled && config.stroke.color.toUpperCase() === DEFAULT_CONFIG.stroke.color) {
    config.stroke.enabled = false;
    changed.push('stroke.enabled');
  }
  return { config, changed };
}

/** Hiệu ứng hiện tại có dùng thời lượng chỉnh được không. */
export const usesDuration = (c: OverlayConfig): boolean => (c.sync !== 'word' && !['cut', 'shake', 'glitch'].includes(c.enter)) || c.exit !== 'cut' || c.wordEffect === 'pop';
/** Hiệu ứng hiện tại có dùng độ nảy hoặc cường độ không. */
export const usesIntensity = (c: OverlayConfig): boolean => (c.sync !== 'word' && ['pop', 'bounce', 'shake'].includes(c.enter)) || c.wordEffect === 'pop' || c.wordEffect === 'active';

export const sizeOf = (c: Pick<OverlayConfig, 'aspect'>): { width: number; height: number } => SIZE_OF[c.aspect];
export const isTransparent = (c: Pick<OverlayConfig, 'background'>): boolean => c.background === 'transparent';

// ---- Kiểu của một cảnh (dùng chung với dịch video, spec 006) -------------------------------------

/** Mọi thứ bộ vẽ cần biết về chữ và hiệu ứng, không gắn với ba tỉ lệ của Video Overlay. */
export type SceneStyle = Pick<
  OverlayConfig,
  | 'background'
  | 'font'
  | 'text'
  | 'stroke'
  | 'box'
  | 'position'
  | 'align'
  | 'maxWidthPct'
  | 'sync'
  | 'enter'
  | 'wordEffect'
  | 'exit'
  | 'effectMs'
  | 'intensity'
  | 'highlightColor'
  | 'shakeScope'
> & {
  /** `distance` (px khung chuẩn) và `opacity` (0–100) chỉ dịch video dùng; vắng thì bóng lệch theo cỡ chữ và đậm hoàn toàn */
  shadow: OverlayConfig['shadow'] & { distance?: number; opacity?: number };
  /** dòng thứ hai của cue song ngữ, nằm trên khối chính (spec 006, FR-026) */
  secondary?: { size: number; color: string; opacity: number };
  /** khung chuẩn: bố cục (cách xuống dòng, vị trí) chỉ phụ thuộc khung này; mọi thông số điểm ảnh tính trên nó */
  frame: { width: number; height: number };
  /** hệ số từ khung chuẩn ra khung đích: nhân vào mọi thông số điểm ảnh khi vẽ */
  k: number;
};

/** Cạnh ngắn của khung chuẩn cho video bất kỳ (research R2). */
export const CANONICAL_SHORT_SIDE = 1080;

/** Khung chuẩn giữ tỉ lệ video đích, kèm hệ số `k` để vẽ ra đúng kích thước đó. */
export function canonicalFrame(width: number, height: number): Pick<SceneStyle, 'frame' | 'k'> {
  const short = CANONICAL_SHORT_SIDE;
  return width <= height
    ? { frame: { width: short, height: (height * short) / width }, k: width / short }
    : { frame: { width: (width * short) / height, height: short }, k: height / short };
}

/** Kích thước điểm ảnh của khung đích. */
export const outputSize = (s: Pick<SceneStyle, 'frame' | 'k'>): { width: number; height: number } => ({
  width: Math.round(s.frame.width * s.k),
  height: Math.round(s.frame.height * s.k),
});

/** Cấu hình Video Overlay là một kiểu cảnh với khung chuẩn đúng bằng khung xuất (`k = 1`). */
export const overlaySceneStyle = (c: OverlayConfig): SceneStyle => ({
  background: c.background,
  font: c.font,
  text: c.text,
  stroke: c.stroke,
  shadow: c.shadow,
  box: c.box,
  position: c.position,
  align: c.align,
  maxWidthPct: c.maxWidthPct,
  sync: c.sync,
  enter: c.enter,
  wordEffect: c.wordEffect,
  exit: c.exit,
  effectMs: c.effectMs,
  intensity: c.intensity,
  highlightColor: c.highlightColor,
  shakeScope: c.shakeScope,
  frame: sizeOf(c),
  k: 1,
});
