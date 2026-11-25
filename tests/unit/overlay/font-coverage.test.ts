import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { allFontFiles, FALLBACK_FAMILY, FONT_FAMILIES, FONT_WEIGHTS, fontFilesFor, hasGlyph, hasWeight, missingChars, VIETNAMESE_CHARS, WEIGHTS_OF } from '@/lib/overlay/fonts';
import { config, coverage, cue, isWhite, boundsWhere, render, sceneOf } from './helpers';

/** Phông chữ của video overlay (spec 005, FR-012, T055). */
const cov = coverage();

describe('danh mục phông chữ', () => {
  it('mọi tệp có trên đĩa, có trong bảng ký tự và có giấy phép', () => {
    for (const f of allFontFiles()) {
      expect(existsSync(path.resolve('public/fonts/overlay', f.file)), f.file).toBe(true);
      expect(cov[f.family]?.[String(f.weight)]?.length, f.file).toBeGreaterThan(0);
    }
    for (const family of [...FONT_FAMILIES, FALLBACK_FAMILY]) {
      expect(existsSync(path.resolve('public/fonts/overlay/licenses', `${family}-OFL.txt`)), family).toBe(true);
    }
  });

  it('arimo không có độ đậm 800; các họ khác có đủ ba độ đậm', () => {
    expect(hasWeight('arimo', 800)).toBe(false);
    for (const f of FONT_FAMILIES) for (const w of FONT_WEIGHTS) expect(hasWeight(f, w), `${f} ${w}`).toBe(f !== 'arimo' || w !== 800);
    expect(fontFilesFor('arimo').map((x) => x.file)).toEqual(['arimo-400.ttf', 'arimo-700.ttf', 'noto-sans-400.ttf', 'noto-sans-700.ttf']);
  });
});

describe('chữ tiếng Việt', () => {
  it('danh sách kiểm đủ 134 chữ có dấu cùng chữ cái, chữ số, dấu câu', () => {
    const marked = [...VIETNAMESE_CHARS].filter((c) => /\p{L}/u.test(c) && c.charCodeAt(0) > 127);
    expect(marked).toHaveLength(134);
    for (const c of 'ĐđƠơƯưẠạẶặỆệỔổỮữỲỳỸỹ') expect(VIETNAMESE_CHARS).toContain(c);
  });

  it.each(FONT_FAMILIES.flatMap((f) => WEIGHTS_OF[f].map((w) => [f, w] as const)))('%s %i có đủ, không cần phông chữ thay thế', (family, weight) => {
    const lacking = [...VIETNAMESE_CHARS].filter((c) => !hasGlyph(cov, family, weight, c.codePointAt(0)!));
    expect(lacking).toEqual([]);
  });

  it('dạng tách dấu (NFD) cũng không báo thiếu', () => {
    expect(missingChars('Nguyễn Trường Tộ ở Đà Nẵng'.normalize('NFD'), 'roboto', 700, cov)).toEqual([]);
  });
});

describe('ký tự lạ', () => {
  it('rơi về phông chữ thay thế rồi mới báo thiếu', () => {
    const only = [...'ἀΩЖя'].filter((c) => FONT_FAMILIES.some((f) => !hasGlyph(cov, f, 700, c.codePointAt(0)!) && hasGlyph(cov, FALLBACK_FAMILY, 700, c.codePointAt(0)!)));
    expect(only.length, 'cần ít nhất một ký tự chỉ có ở phông chữ thay thế').toBeGreaterThan(0);
    for (const f of FONT_FAMILIES) expect(missingChars(only.join(''), f, 700, cov)).toEqual([]);
    expect(missingChars('Xin chào 😀 中文 😀', 'inter', 700, cov)).toEqual(['😀', '中', '文']);
  });

  it('khoảng trắng, dấu nối không độ rộng và bộ chọn biến thể không bị tính là thiếu', () => {
    expect(missingChars('a b​c‍d️\n', 'inter', 400, cov)).toEqual([]);
  });

  it('ký tự chỉ có ở phông chữ thay thế vẫn được vẽ ra', () => {
    const f = render(sceneOf(config({ stroke: { enabled: false, color: '#000000', width: 6 } }), [cue({ text: 'Ω' })]), 2000);
    expect(boundsWhere(f, isWhite)?.count ?? 0).toBeGreaterThan(200);
  });
});
