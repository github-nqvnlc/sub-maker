import { describe, expect, it } from 'vitest';
import type { Background, OverlayConfig } from '@/lib/overlay/config';
import { boundsWhere, config, cue, isWhite, notGreen, pixel, render, sameFrame, sceneOf } from './helpers';

const AT = 2000; // giữa cue 1000–3000
const draw = (over: Partial<OverlayConfig> = {}, text = 'Xin chào các bạn', t = AT) => render(sceneOf(config(over), [cue({ text })]), t);

describe('drawFrame: nền', () => {
  it.each([
    ['green', [0, 255, 0, 255]],
    ['blue', [0, 0, 255, 255]],
    ['black', [0, 0, 0, 255]],
    ['transparent', [0, 0, 0, 0]],
  ] as Array<[Background, number[]]>)('%s đồng nhất khi không có câu', (background, rgba) => {
    const f = draw({ background, format: background === 'transparent' ? 'mov' : 'mp4' }, 'x', 100);
    expect(f.key).toBe('bg');
    for (const [x, y] of [[0, 0], [540, 960], [1079, 1919], [300, 1570]] as const) expect(pixel(f, x, y)).toEqual(rgba);
    expect(boundsWhere(f, (r, g, b, a) => r !== rgba[0] || g !== rgba[1] || b !== rgba[2] || a !== rgba[3])).toBeNull();
  });
});

describe('drawFrame: thời điểm', () => {
  it('chữ chỉ hiện trong [bắt đầu, kết thúc)', () => {
    const scene = sceneOf(config(), [cue({ startMs: 1000, endMs: 3000 })]);
    const has = (t: number) => boundsWhere(render(scene, t), isWhite) !== null;
    expect([has(0), has(999), has(1000), has(2999), has(3000), has(5000)]).toEqual([false, false, true, true, false, false]);
  });

  it('khung cùng câu đứng yên có cùng khóa và giống hệt nhau; khác câu thì khác khóa', () => {
    const scene = sceneOf(config(), [cue(), cue({ i: 1, startMs: 4000, endMs: 5000, text: 'Câu khác' })]);
    const a = render(scene, 1200);
    const b = render(scene, 2900);
    const c = render(scene, 4500);
    expect(a.key).not.toBeNull();
    expect(b.key).toBe(a.key);
    expect(sameFrame(a, b)).toBe(true);
    expect(c.key).not.toBe(a.key);
  });

  it('tất định: cảnh dựng mới cho cùng điểm ảnh', () => {
    expect(sameFrame(draw(), draw())).toBe(true);
  });
});

describe('drawFrame: kiểu chữ', () => {
  it('màu chữ và vị trí: khối nằm đúng độ cao, canh giữa', () => {
    const f = draw();
    const b = boundsWhere(f, isWhite)!;
    expect(Math.abs(b.cx - 540)).toBeLessThan(12);
    expect(Math.abs(b.cy - 1920 * 0.82)).toBeLessThan(40);
    const red = boundsWhere(draw({ text: { color: '#FF0000' } }), (r, g, bl) => r > 250 && g < 5 && bl < 5);
    expect(red).not.toBeNull();
  });

  it('vị trí trên, giữa; canh trái, phải', () => {
    expect(boundsWhere(draw({ position: { anchor: 'top', y: 18 } }), isWhite)!.cy).toBeLessThan(1920 * 0.25);
    expect(Math.abs(boundsWhere(draw({ position: { anchor: 'center', y: 50 } }), isWhite)!.cy - 960)).toBeLessThan(40);
    expect(boundsWhere(draw({ align: 'left' }, 'Ngắn'), isWhite)!.x0).toBeLessThan(100);
    expect(boundsWhere(draw({ align: 'right' }, 'Ngắn'), isWhite)!.x1).toBeGreaterThan(980);
  });

  it('viền mở rộng vùng vẽ theo độ dày; tắt viền thì không còn màu viền', () => {
    const none = boundsWhere(draw({ stroke: { enabled: false, color: '#000000', width: 10 } }), notGreen)!;
    const ten = boundsWhere(draw({ stroke: { enabled: true, color: '#000000', width: 10 } }), notGreen)!;
    expect(none.x0 - ten.x0).toBeGreaterThanOrEqual(9);
    expect(none.x0 - ten.x0).toBeLessThanOrEqual(12);
    expect(boundsWhere(draw({ stroke: { enabled: false, color: '#000000', width: 10 } }), (r, g, b) => r < 5 && g < 5 && b < 5)).toBeNull();
  });

  it('bóng mở rộng xuống dưới; hộp nền phủ sau chữ, bo góc và độ đục có tác dụng', () => {
    const plain = boundsWhere(draw({ stroke: { enabled: false, color: '#000000', width: 1 } }), notGreen)!;
    const shadow = boundsWhere(draw({ stroke: { enabled: false, color: '#000000', width: 1 }, shadow: { enabled: true, color: '#FF00FF', blur: 20 } }), notGreen)!;
    expect(shadow.y1).toBeGreaterThan(plain.y1 + 5);

    const isBox = (r: number, g: number, b: number) => r === 0 && g === 0 && b === 255;
    const sharp = boundsWhere(draw({ box: { enabled: true, color: '#0000FF', radius: 0, opacity: 100 } }), isBox)!;
    const round = boundsWhere(draw({ box: { enabled: true, color: '#0000FF', radius: 40, opacity: 100 } }), isBox)!;
    expect(sharp.w).toBeGreaterThan(plain.w);
    expect(sharp.h).toBeGreaterThan(plain.h);
    const corner = pixel(draw({ box: { enabled: true, color: '#0000FF', radius: 40, opacity: 100 } }), sharp.x0 + 1, sharp.y0 + 1);
    expect(corner.slice(0, 3)).toEqual([0, 255, 0]);
    expect(round.count).toBeLessThan(sharp.count);

    const half = pixel(draw({ background: 'transparent', format: 'mov', box: { enabled: true, color: '#0000FF', radius: 0, opacity: 50 } }), sharp.x0 + 6, sharp.y0 + 6);
    expect(half[2]).toBeGreaterThan(250);
    expect(half[3]).toBeGreaterThan(120);
    expect(half[3]).toBeLessThan(135);
  });

  it('cỡ chữ, độ đậm và phông chữ đổi hình chữ', () => {
    const base = boundsWhere(draw(), isWhite)!;
    expect(boundsWhere(draw({ font: { family: 'be-vietnam-pro', size: 120, weight: 700 } }, 'Xin'), isWhite)!.h).toBeGreaterThan(boundsWhere(draw({}, 'Xin'), isWhite)!.h * 1.4);
    expect(boundsWhere(draw({ font: { family: 'be-vietnam-pro', size: 72, weight: 800 } }), isWhite)!.count).toBeGreaterThan(boundsWhere(draw({ font: { family: 'be-vietnam-pro', size: 72, weight: 400 } }), isWhite)!.count);
    for (const family of ['roboto', 'montserrat', 'inter', 'arimo'] as const) {
      expect(sameFrame(draw({ font: { family, size: 72, weight: 700 } }), draw())).toBe(false);
    }
    expect(base.count).toBeGreaterThan(1000);
  });

  it('chữ có thẻ và ký tự đặc biệt được vẽ như chữ thường (FR-046)', () => {
    for (const text of ['<b>đậm</b>', '{\\an8}trên', '100% & "nháy" \\n', "'; DROP TABLE"]) {
      const f = draw({}, text);
      expect(boundsWhere(f, isWhite)!.count).toBeGreaterThan(200);
    }
    expect(boundsWhere(draw({}, '<b>đậm</b>'), isWhite)!.w).toBeGreaterThan(boundsWhere(draw({}, 'đậm'), isWhite)!.w);
  });

  it('chữ tiếng Việt đủ dấu ở mọi phông chữ: khác hẳn chữ không dấu', () => {
    for (const family of ['be-vietnam-pro', 'roboto', 'montserrat', 'inter', 'arimo'] as const) {
      const font = { family, size: 72, weight: 700 as const };
      expect(sameFrame(draw({ font }, 'phượng hoàng'), draw({ font }, 'phuong hoang'))).toBe(false);
    }
  });
});

describe('drawFrame: tỉ lệ khung', () => {
  it.each([
    ['9:16', 1080, 1920],
    ['16:9', 1920, 1080],
    ['1:1', 1080, 1080],
  ] as const)('%s vẽ đúng kích thước', (aspect, w, h) => {
    const f = draw({ aspect });
    expect([f.width, f.height]).toEqual([w, h]);
    expect(boundsWhere(f, isWhite)).not.toBeNull();
  });
});
