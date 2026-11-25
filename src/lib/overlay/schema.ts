import { z } from 'zod';
import {
  ALIGNS,
  ANCHORS,
  ASPECTS,
  BACKGROUNDS,
  configProblems,
  DEFAULT_CONFIG,
  ENTERS,
  EXITS,
  FORMATS,
  INTENSITIES,
  LIMITS,
  SHAKE_SCOPES,
  SYNCS,
  WORD_EFFECTS,
  type OverlayConfig,
} from './config';
import { FONT_FAMILIES } from './fonts';

/**
 * Kiểm tra cấu hình ở máy chủ (FR-046): danh sách đóng, số trong khoảng, màu `#RRGGBB`, không nhận trường lạ. Tách khỏi `config.ts`
 * để mã phía trình duyệt không phải mang theo zod.
 */
const color = z
  .string()
  .regex(/^#[0-9a-f]{6}$/i)
  .transform((s) => s.toUpperCase());
const int = (r: { min: number; max: number }) => z.number().int().min(r.min).max(r.max);

const baseSchema = z
  .object({
    aspect: z.enum(ASPECTS),
    background: z.enum(BACKGROUNDS),
    format: z.enum(FORMATS),
    includeAudio: z.boolean(),
    font: z
      .object({
        family: z.enum(FONT_FAMILIES),
        size: int(LIMITS.fontSize),
        weight: z.union([z.literal(400), z.literal(700), z.literal(800)]),
      })
      .strict(),
    text: z.object({ color }).strict(),
    stroke: z.object({ enabled: z.boolean(), color, width: int(LIMITS.strokeWidth) }).strict(),
    shadow: z.object({ enabled: z.boolean(), color, blur: int(LIMITS.shadowBlur) }).strict(),
    box: z.object({ enabled: z.boolean(), color, radius: int(LIMITS.boxRadius), opacity: int(LIMITS.boxOpacity) }).strict(),
    position: z.object({ anchor: z.enum(ANCHORS), y: int(LIMITS.y) }).strict(),
    align: z.enum(ALIGNS),
    maxWidthPct: int(LIMITS.maxWidthPct),
    sync: z.enum(SYNCS),
    enter: z.enum(ENTERS),
    wordEffect: z.enum(WORD_EFFECTS),
    exit: z.enum(EXITS),
    effectMs: int(LIMITS.effectMs).multipleOf(LIMITS.effectMs.step),
    intensity: z.enum(INTENSITIES),
    highlightColor: color,
    shakeScope: z.enum(SHAKE_SCOPES),
  })
  .strict();

export const overlayConfigSchema = baseSchema.superRefine((c, ctx) => {
  for (const path of configProblems(c)) ctx.addIssue({ code: 'custom', path: path.split('.'), message: 'invalid combination' });
});

/** Đọc cấu hình đã lưu (có thể từ phiên bản cũ): không hợp lệ thì về mặc định. */
export function parseStoredConfig(value: unknown): OverlayConfig {
  const r = overlayConfigSchema.safeParse(value);
  return r.success ? r.data : structuredClone(DEFAULT_CONFIG);
}
