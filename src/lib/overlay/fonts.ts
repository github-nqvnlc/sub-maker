/**
 * Phông chữ của video overlay (spec 005, FR-012, research R9). Dùng chung cho trình duyệt (FontFace) và tiến trình dựng hình
 * (GlobalFonts): cùng tệp TTF trong `public/fonts/overlay` là điều kiện để xem trước giống video. Mã thuần, không đọc tệp.
 */

export const FONT_FAMILIES = ['be-vietnam-pro', 'roboto', 'montserrat', 'inter', 'arimo', 'oswald', 'open-sans'] as const;
export type FontFamily = (typeof FONT_FAMILIES)[number];
/** Bộ phông chữ cũ của tab Video Overlay (spec 005, FR-012; spec 006 T095 giữ tab Video Overlay nguyên bộ cũ). */
export const OVERLAY_FONT_FAMILIES = ['be-vietnam-pro', 'roboto', 'montserrat', 'inter', 'arimo'] as const;
export type OverlayFontFamily = (typeof OVERLAY_FONT_FAMILIES)[number];
export const FONT_WEIGHTS = [400, 600, 700, 800] as const;
export type FontWeight = (typeof FONT_WEIGHTS)[number];
export const OVERLAY_FONT_WEIGHTS = [400, 700, 800] as const;
export type OverlayFontWeight = (typeof OVERLAY_FONT_WEIGHTS)[number];

/** Phông chữ thay thế khi phông chữ đã chọn thiếu ký tự. */
export const FALLBACK_FAMILY = 'noto-sans';

/** Tên hiển thị là tên riêng nên không dịch. Arimo có cùng độ rộng chữ với Arial và được phép phân phối. */
export const FONT_LABELS: Record<FontFamily, string> = {
  'be-vietnam-pro': 'Be Vietnam Pro',
  roboto: 'Roboto',
  montserrat: 'Montserrat',
  inter: 'Inter',
  arimo: 'Arimo (Arial)',
  oswald: 'Oswald',
  'open-sans': 'Open Sans',
};

/** Độ đậm có sẵn của từng họ (Arimo không có 600/800; Oswald không có 800). */
export const WEIGHTS_OF: Record<FontFamily | typeof FALLBACK_FAMILY, readonly FontWeight[]> = {
  'be-vietnam-pro': [400, 600, 700, 800],
  roboto: [400, 600, 700, 800],
  montserrat: [400, 600, 700, 800],
  inter: [400, 600, 700, 800],
  arimo: [400, 700],
  oswald: [400, 600, 700],
  'open-sans': [400, 600, 700, 800],
  'noto-sans': [400, 700],
};

export const hasWeight = (family: FontFamily, weight: number): boolean => (WEIGHTS_OF[family] as readonly number[]).includes(weight);
export const hasOverlayWeight = (family: OverlayFontFamily, weight: number): boolean =>
  (OVERLAY_FONT_WEIGHTS as readonly number[]).includes(weight) && hasWeight(family, weight);

/** Tên họ đăng ký riêng để không lẫn với phông chữ cài sẵn trên máy. */
export const registeredName = (family: string): string => `ov-${family}`;
export const fontFileName = (family: string, weight: number): string => `${family}-${weight}.ttf`;
export const FONT_PUBLIC_PATH = '/fonts/overlay';

export type FontFile = { family: string; weight: FontWeight; file: string };

/** Mọi tệp cần nạp để vẽ một họ phông chữ (gồm phông chữ thay thế). */
export function fontFilesFor(family: FontFamily): FontFile[] {
  return [family, FALLBACK_FAMILY].flatMap((f) =>
    WEIGHTS_OF[f as FontFamily].map((weight) => ({ family: f, weight, file: fontFileName(f, weight) })),
  );
}

export function allFontFiles(): FontFile[] {
  return [...FONT_FAMILIES, FALLBACK_FAMILY].flatMap((f) => WEIGHTS_OF[f as FontFamily].map((weight) => ({ family: f, weight, file: fontFileName(f, weight) })));
}

/** Chuỗi `ctx.font`; phông chữ thay thế đứng sau. */
export function fontString(family: FontFamily, weight: number, size: number): string {
  return `${weight} ${size}px "${registeredName(family)}", "${registeredName(FALLBACK_FAMILY)}"`;
}

// ---- Ký tự hỗ trợ -------------------------------------------------------------------------------

/** Khoảng mã ký tự (bao gồm hai đầu) theo họ và độ đậm; sinh bằng scripts/build-font-coverage.ts. */
export type FontCoverage = Record<string, Record<string, Array<[number, number]>>>;

function inRanges(ranges: ReadonlyArray<readonly [number, number]>, cp: number): boolean {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = ranges[mid]!;
    if (cp < r[0]) hi = mid - 1;
    else if (cp > r[1]) lo = mid + 1;
    else return true;
  }
  return false;
}

/** Độ đậm gần nhất có tệp của một họ. */
function nearestWeight(family: string, weight: number): number {
  const list = WEIGHTS_OF[family as FontFamily] as readonly number[];
  return list.reduce((best, w) => (Math.abs(w - weight) < Math.abs(best - weight) ? w : best), list[0]!);
}

export function hasGlyph(coverage: FontCoverage, family: string, weight: number, cp: number): boolean {
  const ranges = coverage[family]?.[String(nearestWeight(family, weight))];
  return ranges ? inRanges(ranges, cp) : false;
}

/** Ký tự không có trong phông chữ lẫn phông chữ thay thế (không trùng lặp, theo thứ tự xuất hiện). */
export function missingChars(text: string, family: FontFamily, weight: number, coverage: FontCoverage): string[] {
  const out = new Set<string>();
  for (const ch of text.normalize('NFC')) {
    if (/\s/u.test(ch)) continue;
    const cp = ch.codePointAt(0)!;
    // dấu nối không độ rộng và bộ chọn biến thể không có hình riêng
    if (cp === 0x200d || cp === 0x200b || (cp >= 0xfe00 && cp <= 0xfe0f)) continue;
    if (!hasGlyph(coverage, family, weight, cp) && !hasGlyph(coverage, FALLBACK_FAMILY, weight, cp)) out.add(ch);
  }
  return [...out];
}

/** Chữ tiếng Việt dựng sẵn (NFC), chữ số và dấu câu thường gặp: mọi phông chữ trong danh mục phải có đủ. */
export const VIETNAMESE_CHARS: string = (() => {
  const base = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const marks = 'àáảãạăằắẳẵặâầấẩẫậđèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵ';
  const punct = '.,;:!?…"\'()[]-–—/%&+=“”‘’';
  const lower = (base + marks).normalize('NFC');
  return [...new Set([...lower, ...lower.toUpperCase(), ...punct])].join('');
})();
