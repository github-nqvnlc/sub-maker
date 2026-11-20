import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Spec 003, FR-019 / SC-007: viền ô nhập (`--field-border`) phải có tương phản ≥ 3:1 (WCAG 1.4.11) với nền trang,
 * thẻ và ô điền ở CẢ HAI theme. Đọc trực tiếp src/app/globals.css nên đổi token sai sẽ làm test thất bại.
 */
const css = fs.readFileSync(path.resolve(process.cwd(), 'src/app/globals.css'), 'utf8');

/** Lấy nội dung khối `:root { … }` hoặc `.dark { … }` (khối nằm ngoài @theme). */
function block(selector: string): string {
  const start = css.indexOf(`\n${selector} {`);
  expect(start, `không thấy khối ${selector}`).toBeGreaterThanOrEqual(0);
  const open = css.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    if (css[i] === '}' && --depth === 0) return css.slice(open + 1, i);
  }
  throw new Error(`khối ${selector} không đóng`);
}

type Lch = [number, number, number];
function token(b: string, name: string): Lch {
  const m = new RegExp(`--${name}:\\s*oklch\\(\\s*([\\d.]+)\\s+([\\d.]+)\\s+([\\d.]+)`).exec(b);
  expect(m, `thiếu --${name}`).not.toBeNull();
  return [Number(m![1]), Number(m![2]), Number(m![3])];
}

/** OKLCH → sRGB tuyến tính (cắt về [0,1]) → độ chói tương đối theo WCAG. */
function luminance([L, C, h]: Lch): number {
  const a = C * Math.cos((h * Math.PI) / 180);
  const b = C * Math.sin((h * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const rgb = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s].map((v) => Math.min(1, Math.max(0, v)));
  return 0.2126 * rgb[0]! + 0.7152 * rgb[1]! + 0.0722 * rgb[2]!;
}
function contrast(a: Lch, b: Lch): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

describe('viền ô nhập đạt tương phản ≥ 3:1 (FR-019)', () => {
  for (const [name, selector] of [
    ['Sáng', ':root'],
    ['Tối', '.dark'],
  ] as const) {
    it(`theme ${name}: --field-border so với --background, --card và --input`, () => {
      const b = block(selector);
      const field = token(b, 'field-border');
      for (const other of ['background', 'card', 'input']) {
        const ratio = contrast(field, token(b, other));
        expect(ratio, `--field-border / --${other} (${name}) = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(3);
      }
    });
  }

  it('token đã được đăng ký cho Tailwind (@theme inline) và dùng ở các ô nhập chung', () => {
    expect(css).toMatch(/--color-field-border:\s*var\(--field-border\)/);
    for (const f of ['input', 'textarea', 'select', 'checkbox']) {
      const src = fs.readFileSync(path.resolve(process.cwd(), `src/components/ui/${f}.tsx`), 'utf8');
      expect(src, `${f}.tsx`).toContain('border-field-border');
      expect(src, `${f}.tsx không còn border-input`).not.toMatch(/\bborder-input\b/);
    }
  });

  it('chứng minh cần token riêng: --input/--border cũ của theme chỉ ~1,1–1,3:1 (dưới ngưỡng)', () => {
    const light = block(':root');
    expect(contrast(token(light, 'input'), token(light, 'background'))).toBeLessThan(1.5);
    expect(contrast(token(light, 'border'), token(light, 'background'))).toBeLessThan(1.5);
  });
});
