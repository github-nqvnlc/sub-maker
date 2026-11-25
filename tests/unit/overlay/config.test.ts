import { describe, expect, it } from 'vitest';
import { applyBackground, DEFAULT_CONFIG, formatsOf, normalizeConfig, sizeOf, type OverlayConfig } from '@/lib/overlay/config';
import { overlayConfigSchema, parseStoredConfig } from '@/lib/overlay/schema';

const ok = (c: unknown) => overlayConfigSchema.safeParse(c).success;
const mut = (fn: (c: OverlayConfig) => void): OverlayConfig => {
  const c = structuredClone(DEFAULT_CONFIG);
  fn(c);
  return c;
};

describe('OverlayConfig', () => {
  it('cấu hình mặc định hợp lệ và theo đặc tả', () => {
    expect(ok(DEFAULT_CONFIG)).toBe(true);
    expect(DEFAULT_CONFIG).toMatchObject({ aspect: '9:16', background: 'green', format: 'mp4', includeAudio: true, sync: 'cue', enter: 'cut', exit: 'cut', effectMs: 250, maxWidthPct: 90, align: 'center' });
    expect(DEFAULT_CONFIG.position).toEqual({ anchor: 'bottom', y: 82 });
  });

  it('kích thước theo tỉ lệ', () => {
    expect(sizeOf({ aspect: '9:16' })).toEqual({ width: 1080, height: 1920 });
    expect(sizeOf({ aspect: '16:9' })).toEqual({ width: 1920, height: 1080 });
    expect(sizeOf({ aspect: '1:1' })).toEqual({ width: 1080, height: 1080 });
  });

  it.each([
    ['cỡ chữ', (c: OverlayConfig, v: number) => void (c.font.size = v), 24, 160],
    ['độ dày viền', (c: OverlayConfig, v: number) => void (c.stroke.width = v), 1, 20],
    ['độ mờ bóng', (c: OverlayConfig, v: number) => void (c.shadow.blur = v), 0, 40],
    ['bo góc', (c: OverlayConfig, v: number) => void (c.box.radius = v), 0, 60],
    ['độ đục', (c: OverlayConfig, v: number) => void (c.box.opacity = v), 0, 100],
    ['độ cao', (c: OverlayConfig, v: number) => void (c.position.y = v), 0, 100],
    ['độ rộng tối đa', (c: OverlayConfig, v: number) => void (c.maxWidthPct = v), 40, 100],
    ['thời lượng hiệu ứng', (c: OverlayConfig, v: number) => void (c.effectMs = v), 100, 600],
  ])('%s: nhận hai đầu khoảng, từ chối ngoài khoảng và số lẻ', (_n, set, min, max) => {
    expect(ok(mut((c) => set(c, min)))).toBe(true);
    expect(ok(mut((c) => set(c, max)))).toBe(true);
    expect(ok(mut((c) => set(c, min - 1)))).toBe(false);
    expect(ok(mut((c) => set(c, max + 1)))).toBe(false);
    expect(ok(mut((c) => set(c, min + 0.5)))).toBe(false);
    expect(ok(mut((c) => set(c, Number.NaN)))).toBe(false);
  });

  it('thời lượng hiệu ứng là bội số của 10', () => {
    expect(ok(mut((c) => void (c.effectMs = 255)))).toBe(false);
    expect(ok(mut((c) => void (c.effectMs = 260)))).toBe(true);
  });

  it('từ chối trường lạ, màu sai, giá trị ngoài danh sách', () => {
    expect(ok({ ...DEFAULT_CONFIG, extra: 1 })).toBe(false);
    expect(ok({ ...DEFAULT_CONFIG, font: { ...DEFAULT_CONFIG.font, url: 'x' } })).toBe(false);
    for (const bad of ['#FFF', 'red', '#GGGGGG', '#FFFFFF00', 'url(x)', '']) expect(ok(mut((c) => void (c.text.color = bad)))).toBe(false);
    expect(ok({ ...DEFAULT_CONFIG, enter: 'spin' })).toBe(false);
    expect(ok({ ...DEFAULT_CONFIG, aspect: '4:3' })).toBe(false);
  });

  it('màu được viết hoa thống nhất', () => {
    expect(overlayConfigSchema.parse(mut((c) => void (c.text.color = '#a1b2c3'))).text.color).toBe('#A1B2C3');
  });

  it('độ đậm 800 không hợp với Arimo', () => {
    expect(ok(mut((c) => void (c.font = { family: 'arimo', size: 72, weight: 800 })))).toBe(false);
    expect(ok(mut((c) => void (c.font = { family: 'arimo', size: 72, weight: 700 })))).toBe(true);
    expect(ok(mut((c) => void (c.font = { family: 'inter', size: 72, weight: 800 })))).toBe(true);
  });

  it('định dạng phải hợp với nền (FR-032)', () => {
    expect(formatsOf('green')).toEqual(['mp4']);
    expect(formatsOf('transparent')).toEqual(['mov', 'webm']);
    expect(ok(mut((c) => void (c.format = 'mov')))).toBe(false);
    expect(ok(mut((c) => Object.assign(c, { background: 'transparent', format: 'mp4' })))).toBe(false);
    expect(ok(mut((c) => Object.assign(c, { background: 'transparent', format: 'webm' })))).toBe(true);
  });

  it('hiệu ứng từ và hiệu ứng vào phải hợp với chế độ', () => {
    expect(ok(mut((c) => Object.assign(c, { sync: 'word', wordEffect: 'pop' })))).toBe(true);
    expect(ok(mut((c) => Object.assign(c, { sync: 'word', wordEffect: 'active' })))).toBe(false);
    expect(ok(mut((c) => Object.assign(c, { sync: 'word', wordEffect: 'cut', enter: 'fade' })))).toBe(false);
    expect(ok(mut((c) => Object.assign(c, { sync: 'karaoke', wordEffect: 'wipe', enter: 'fade' })))).toBe(true);
    expect(ok(mut((c) => Object.assign(c, { sync: 'cue', wordEffect: 'cut' })))).toBe(false);
  });

  it('normalizeConfig đưa về mặc định của chế độ và trả trường đã sửa (FR-028)', () => {
    const r = normalizeConfig(mut((c) => Object.assign(c, { sync: 'word', wordEffect: 'none', enter: 'bounce' })));
    expect(r.config).toMatchObject({ sync: 'word', wordEffect: 'cut', enter: 'cut' });
    expect(r.changed.sort()).toEqual(['enter', 'wordEffect']);
    expect(ok(r.config)).toBe(true);
    expect(normalizeConfig(DEFAULT_CONFIG).changed).toEqual([]);
    expect(normalizeConfig(mut((c) => void (c.font = { family: 'arimo', size: 72, weight: 800 }))).config.font.weight).toBe(700);
  });

  it('normalizeConfig không sửa đối tượng gốc', () => {
    const src = mut((c) => Object.assign(c, { sync: 'karaoke' }));
    normalizeConfig(src);
    expect(src.wordEffect).toBe('none');
  });

  it('applyBackground: chọn định dạng hợp lệ; phông đen tắt viền đen mặc định, giữ viền màu khác', () => {
    expect(applyBackground(DEFAULT_CONFIG, 'transparent').config.format).toBe('mov');
    const black = applyBackground(DEFAULT_CONFIG, 'black');
    expect(black.config.stroke.enabled).toBe(false);
    expect(black.changed).toContain('stroke.enabled');
    const red = applyBackground(mut((c) => void (c.stroke.color = '#FF0000')), 'black');
    expect(red.config.stroke.enabled).toBe(true);
    expect(red.changed).not.toContain('stroke.enabled');
    expect(applyBackground(DEFAULT_CONFIG, 'blue').config.stroke.enabled).toBe(true);
  });

  it('cấu hình đã lưu không đọc được thì về mặc định', () => {
    expect(parseStoredConfig(null)).toEqual(DEFAULT_CONFIG);
    expect(parseStoredConfig({ aspect: '9:16' })).toEqual(DEFAULT_CONFIG);
    const c = mut((x) => void (x.font.size = 100));
    expect(parseStoredConfig(c).font.size).toBe(100);
  });
});
