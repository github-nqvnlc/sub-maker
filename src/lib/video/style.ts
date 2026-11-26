import { z } from 'zod';
import { canonicalFrame, type SceneStyle } from '../overlay/config';
import { FONT_FAMILIES, hasWeight, type FontWeight } from '../overlay/fonts';
import type { AppliedCue } from '../overlay/types';
import type { Cue } from './types';

/**
 * Kiểu phụ đề của dịch video (spec 006, data-model §2.1). Mọi kích thước tính trên khung chuẩn cạnh ngắn 1080 và co giãn theo video.
 * Đổi sang `SceneStyle` của bộ vẽ dùng chung nên khung xem trước và thành phẩm giống nhau.
 */
export const DISPLAYS = ['target', 'bilingual', 'source'] as const;
export const STYLE_ANCHORS = ['bottom', 'center', 'top'] as const;
export const STYLE_ALIGNS = ['left', 'center', 'right'] as const;
export const STYLE_SYNCS = ['cue', 'word', 'karaoke'] as const;
export const STYLE_ENTERS = ['cut', 'fade', 'pop', 'bounce', 'slideUp', 'blurIn', 'glow'] as const;
export const STYLE_WORD_EFFECTS = ['none', 'pop', 'typewriter', 'active'] as const;
export const STYLE_WEIGHTS = [400, 600, 700, 800] as const;

export type Display = (typeof DISPLAYS)[number];
export type StyleSync = (typeof STYLE_SYNCS)[number];
export type StyleWordEffect = (typeof STYLE_WORD_EFFECTS)[number];

/** Độ cao của ba vị trí nhanh (phần trăm chiều cao, theo tâm khối chữ) (FR-029). */
export const STYLE_ANCHOR_Y: Record<(typeof STYLE_ANCHORS)[number], number> = { bottom: 85, center: 50, top: 15 };

/** Hiệu ứng từ hợp lệ theo chế độ; phần tử đầu là mặc định. */
export const STYLE_WORD_EFFECTS_OF: Record<StyleSync, readonly StyleWordEffect[]> = {
  cue: ['none'],
  word: ['none', 'pop', 'typewriter'],
  karaoke: ['active'],
};

export const STYLE_LIMITS = {
  size: { min: 16, max: 96 },
  strokeWidth: { min: 1, max: 10 },
  shadowBlur: { min: 0, max: 40 },
  shadowDistance: { min: 0, max: 20 },
  opacity: { min: 0, max: 100 },
  boxRadius: { min: 0, max: 60 },
  y: { min: 0, max: 100 },
  maxWidthPct: { min: 40, max: 100 },
  effectMs: { min: 100, max: 500 },
} as const;

const color = z
  .string()
  .regex(/^#[0-9a-f]{6}$/i)
  .transform((s) => s.toUpperCase());
const int = (r: { min: number; max: number }) => z.number().int().min(r.min).max(r.max);

export const videoStyleSchema = z
  .object({
    display: z.enum(DISPLAYS),
    font: z
      .object({
        family: z.enum(FONT_FAMILIES),
        size: int(STYLE_LIMITS.size),
        weight: z.union([z.literal(400), z.literal(600), z.literal(700), z.literal(800)]),
      })
      .strict(),
    color,
    /** dòng gốc ở chế độ song ngữ */
    sourceLine: z.object({ size: int(STYLE_LIMITS.size), color, opacity: int(STYLE_LIMITS.opacity) }).strict(),
    stroke: z.object({ enabled: z.boolean(), color, width: int(STYLE_LIMITS.strokeWidth) }).strict(),
    shadow: z.object({ enabled: z.boolean(), color, blur: int(STYLE_LIMITS.shadowBlur), distance: int(STYLE_LIMITS.shadowDistance), opacity: int(STYLE_LIMITS.opacity) }).strict(),
    box: z.object({ enabled: z.boolean(), color, radius: int(STYLE_LIMITS.boxRadius), opacity: int(STYLE_LIMITS.opacity) }).strict(),
    position: z.object({ anchor: z.enum(STYLE_ANCHORS), y: int(STYLE_LIMITS.y) }).strict(),
    align: z.enum(STYLE_ALIGNS),
    maxWidthPct: int(STYLE_LIMITS.maxWidthPct),
    sync: z.enum(STYLE_SYNCS),
    enter: z.enum(STYLE_ENTERS),
    wordEffect: z.enum(STYLE_WORD_EFFECTS),
    effectMs: int(STYLE_LIMITS.effectMs),
    highlightColor: color,
  })
  .strict();

export type VideoStyle = z.infer<typeof videoStyleSchema>;

export const DEFAULT_VIDEO_STYLE: VideoStyle = {
  display: 'target',
  font: { family: 'be-vietnam-pro', size: 48, weight: 700 },
  color: '#FFFFFF',
  sourceLine: { size: 32, color: '#FFE08A', opacity: 90 },
  stroke: { enabled: true, color: '#000000', width: 4 },
  shadow: { enabled: false, color: '#000000', blur: 8, distance: 4, opacity: 60 },
  box: { enabled: false, color: '#000000', radius: 12, opacity: 60 },
  position: { anchor: 'bottom', y: STYLE_ANCHOR_Y.bottom },
  align: 'center',
  maxWidthPct: 80,
  sync: 'cue',
  enter: 'cut',
  wordEffect: 'none',
  effectMs: 250,
  highlightColor: '#FFE600',
};

/** Đưa tổ hợp không hợp lệ về mặc định của chế độ; trả kiểu mới và tên các trường đã sửa (cùng cách `normalizeConfig`). */
export function normalizeStyle(input: VideoStyle): { style: VideoStyle; changed: string[] } {
  const style = structuredClone(input);
  const changed: string[] = [];
  if (!hasWeight(style.font.family, style.font.weight)) {
    style.font.weight = 700;
    changed.push('font.weight');
  }
  if (!STYLE_WORD_EFFECTS_OF[style.sync].includes(style.wordEffect)) {
    style.wordEffect = STYLE_WORD_EFFECTS_OF[style.sync][0]!;
    changed.push('wordEffect');
  }
  // theo từng từ: từng từ tự xuất hiện nên không có hiệu ứng vào của cả câu
  if (style.sync === 'word' && style.enter !== 'cut') {
    style.enter = 'cut';
    changed.push('enter');
  }
  return { style, changed };
}

/** Đọc kiểu đã lưu (có thể từ phiên bản cũ): không hợp lệ thì về mặc định, tổ hợp sai thì chuẩn hóa. */
export function parseStoredStyle(value: unknown): VideoStyle {
  const r = videoStyleSchema.safeParse(value);
  return r.success ? normalizeStyle(r.data).style : structuredClone(DEFAULT_VIDEO_STYLE);
}

/** Kiểu cảnh của bộ vẽ cho khung đích `width`×`height` (video nguồn khi xuất, khung hiển thị khi xem trước). */
export function toSceneStyle(input: VideoStyle, width: number, height: number): SceneStyle {
  const { style } = normalizeStyle(input);
  return {
    ...canonicalFrame(width, height),
    background: 'transparent',
    font: { family: style.font.family, size: style.font.size, weight: style.font.weight as FontWeight },
    text: { color: style.color },
    stroke: { ...style.stroke },
    shadow: { enabled: style.shadow.enabled, color: style.shadow.color, blur: style.shadow.blur },
    box: { ...style.box },
    position: { ...style.position },
    align: style.align,
    maxWidthPct: style.maxWidthPct,
    sync: style.sync,
    enter: style.enter,
    wordEffect: style.sync === 'word' && style.wordEffect === 'none' ? 'cut' : style.wordEffect,
    exit: 'cut',
    effectMs: style.effectMs,
    // mức nhẹ: từ đang đọc phóng 115%, "bung ra" đi từ 80% lên đúng 100% (US8)
    intensity: 'low',
    highlightColor: style.highlightColor,
    shakeScope: 'exclaim',
  };
}

/** Chữ hiện trên video của một cue theo chế độ hiển thị; đoạn chưa dịch dùng câu gốc làm câu hiển thị. */
export function cueDisplayText(cue: Pick<Cue, 'sourceText' | 'targetText'>, display: Display): string {
  const text = display === 'source' ? cue.sourceText : cue.targetText.trim() ? cue.targetText : cue.sourceText;
  return text.trim();
}

/** Cue đưa vào bộ vẽ: bỏ cue không có chữ, đánh số liên tục; khoảng đọc từng từ là cả cue (FR-034). */
export function toAppliedCues(cues: ReadonlyArray<Pick<Cue, 'startMs' | 'endMs' | 'sourceText' | 'targetText'>>, display: Display): AppliedCue[] {
  const out: AppliedCue[] = [];
  for (const c of cues) {
    const text = cueDisplayText(c, display).normalize('NFC');
    if (!text) continue;
    out.push({ i: out.length, startMs: c.startMs, endMs: c.endMs, readEndMs: c.endMs, text, origin: 'file' });
  }
  return out;
}
