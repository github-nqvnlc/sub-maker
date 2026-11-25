import { describe, expect, it } from 'vitest';
import type { Background, OverlayConfig } from '@/lib/overlay/config';
import { colorWarnings, isKeyedColor } from '@/lib/overlay/colors';
import { config } from './helpers';

const fields = (c: OverlayConfig) => colorWarnings(c).filter((w) => w.code === 'KEYED_COLOR').map((w) => w.params!.field);
const soft = (c: OverlayConfig) => colorWarnings(c).filter((w) => w.code === 'SOFT_EDGE').length;

describe('màu bị xóa cùng phông (FR-010)', () => {
  it.each([
    ['green', '#00FF00'],
    ['green', '#00FF66'],
    ['green', '#39FF14'],
    ['blue', '#0000FF'],
    ['blue', '#1E40FF'],
    ['black', '#000000'],
    ['black', '#1A1A1A'],
  ] as Array<[Background, string]>)('%s: %s bị cảnh báo', (bg, hex) => expect(isKeyedColor(hex, bg)).toBe(true));

  it.each(['#FFFFFF', '#FFE600', '#FF4500'])('%s không bị cảnh báo trên cả ba phông', (hex) => {
    for (const bg of ['green', 'blue', 'black'] as Background[]) expect(isKeyedColor(hex, bg)).toBe(false);
  });

  it('nền trong suốt không bao giờ cảnh báo màu', () => {
    for (const hex of ['#00FF00', '#0000FF', '#000000']) expect(isKeyedColor(hex, 'transparent')).toBe(false);
  });

  it('chỉ xét thành phần đang bật', () => {
    const green = '#00FF00';
    expect(fields(config({ text: { color: green } }))).toEqual(['text']);
    expect(fields(config({ stroke: { enabled: true, color: green, width: 4 } }))).toEqual(['stroke']);
    expect(fields(config({ stroke: { enabled: false, color: green, width: 4 } }))).toEqual([]);
    expect(fields(config({ box: { enabled: true, color: green, radius: 0, opacity: 100 } }))).toEqual(['box']);
    expect(fields(config({ box: { enabled: true, color: green, radius: 0, opacity: 0 } }))).toEqual([]);
    expect(fields(config({ box: { enabled: false, color: green, radius: 0, opacity: 100 } }))).toEqual([]);
  });

  it('màu nổi bật chỉ xét khi karaoke, hoặc theo câu với hiệu ứng phát sáng', () => {
    const hl = { highlightColor: '#00FF66' };
    expect(fields(config(hl))).toEqual([]);
    expect(fields(config({ ...hl, sync: 'word', wordEffect: 'pop' }))).toEqual([]);
    expect(fields(config({ ...hl, sync: 'karaoke', wordEffect: 'active' }))).toEqual(['highlight']);
    expect(fields(config({ ...hl, enter: 'glow' }))).toEqual(['highlight']);
  });
});

describe('vùng bán trong suốt (FR-011)', () => {
  it.each([
    ['hộp nền chưa đặc', { box: { enabled: true, color: '#333333', radius: 0, opacity: 50 } }],
    ['bóng mờ', { shadow: { enabled: true, color: '#333333', blur: 8 } }],
    ['mờ dần', { enter: 'fade' }],
    ['nhòe', { enter: 'blurIn' }],
    ['phát sáng', { enter: 'glow' }],
    ['tách màu', { enter: 'glitch' }],
    ['biến mất mờ dần', { exit: 'fade' }],
  ] as Array<[string, Partial<OverlayConfig>]>)('%s: cảnh báo một lần trên xanh lá và xanh dương, không trên đen và trong suốt', (_n, over) => {
    expect(soft(config(over))).toBe(1);
    expect(soft(config({ ...over, background: 'blue' }))).toBe(1);
    expect(soft(config({ ...over, background: 'black' }))).toBe(0);
    expect(soft(config({ ...over, background: 'transparent', format: 'mov' }))).toBe(0);
  });

  it.each([
    ['mặc định', {}],
    ['hộp đặc', { box: { enabled: true, color: '#333333', radius: 10, opacity: 100 } }],
    ['bóng không mờ', { shadow: { enabled: true, color: '#333333', blur: 0 } }],
    ['nảy', { enter: 'bounce' }],
    ['lướt ngang', { enter: 'slideLeft' }],
  ] as Array<[string, Partial<OverlayConfig>]>)('%s: không cảnh báo', (_n, over) => expect(soft(config(over))).toBe(0));

  it('nhiều vùng mờ cùng lúc vẫn chỉ một cảnh báo', () => {
    expect(soft(config({ enter: 'fade', exit: 'fade', shadow: { enabled: true, color: '#333333', blur: 20 } }))).toBe(1);
  });
});
