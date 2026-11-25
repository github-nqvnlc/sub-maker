import { describe, expect, it } from 'vitest';
import { SIZE_OF, type Aspect, type OverlayConfig } from '@/lib/overlay/config';
import { missingChars } from '@/lib/overlay/fonts';
import { graphemes, layoutCue, type CueLayout } from '@/lib/overlay/layout';
import { config, coverage, measure } from './helpers';

const m = measure();
const texts = (l: CueLayout) => l.lines.map((x) => x.segments.map((s) => s.text).join(' '));

function expectInside(l: CueLayout, c: OverlayConfig) {
  const { width, height } = SIZE_OF[c.aspect];
  expect(l.box.x - l.bleed).toBeGreaterThanOrEqual(-0.5);
  expect(l.box.y - l.bleed).toBeGreaterThanOrEqual(-0.5);
  expect(l.box.x + l.box.width + l.bleed).toBeLessThanOrEqual(width + 0.5);
  expect(l.box.y + l.box.height + l.bleed).toBeLessThanOrEqual(height + 0.5);
}

describe('layoutCue: xuống dòng', () => {
  const long = 'Nhưng Tập Cận Bình không nhắc đến Nga một lần nào trong bài phát biểu dài hôm qua';

  it('xuống dòng tại khoảng trắng, không vượt độ rộng tối đa, giữ đủ chữ và thứ tự', () => {
    const c = config();
    const l = layoutCue(long, c, m);
    expect(l.lines.length).toBeGreaterThan(1);
    for (const line of l.lines) expect(line.width).toBeLessThanOrEqual((1080 * c.maxWidthPct) / 100);
    expect(texts(l).join(' ')).toBe(long);
    expect(l.lines.flatMap((x) => x.segments.map((s) => s.word))).toEqual([...Array(l.wordCount).keys()]);
  });

  it('độ rộng tối đa nhỏ hơn thì nhiều dòng hơn', () => {
    expect(layoutCue(long, config({ maxWidthPct: 40 }), m).lines.length).toBeGreaterThan(layoutCue(long, config({ maxWidthPct: 100 }), m).lines.length);
  });

  it('chỉ ngắt trong từ khi một từ dài hơn cả dòng, theo cụm ký tự', () => {
    const url = 'https://example.com/duong-dan-rat-dai-khong-co-khoang-trang-nao-ca-de-ngat-dong';
    const l = layoutCue(`Xem ${url} nhé`, config(), m);
    const parts = l.lines.flatMap((x) => x.segments).filter((s) => s.word === 1);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.map((s) => s.text).join('')).toBe(url);
    expectInside(l, config());
  });

  it('không tách dấu khỏi chữ; chữ NFD được chuẩn hóa NFC', () => {
    expect(graphemes('ệ'.normalize('NFD'))).toEqual(['ệ']);
    const nfd = 'Tiếng Việt'.normalize('NFD');
    expect(texts(layoutCue(nfd, config(), m))).toEqual(['Tiếng Việt']);
  });
});

describe('layoutCue: vị trí', () => {
  it('canh trái, giữa, phải', () => {
    const at = (align: OverlayConfig['align']) => layoutCue('Xin chào', config({ align, maxWidthPct: 80 }), m).lines[0]!;
    expect(at('left').x).toBeCloseTo(108, 0);
    expect(at('center').x + at('center').width / 2).toBeCloseTo(540, 0);
    expect(at('right').x + at('right').width).toBeCloseTo(972, 0);
  });

  it('độ cao theo phần trăm tính ở tâm khối; kẹp để không ra khỏi khung', () => {
    const y = (v: number) => layoutCue('Xin chào', config({ position: { anchor: 'center', y: v } }), m);
    expect(y(50).center.y).toBeCloseTo(960, 0);
    expect(y(82).center.y).toBeCloseTo(1920 * 0.82, 0);
    for (const v of [0, 1, 99, 100]) expectInside(y(v), config());
  });

  it.each(['9:16', '16:9', '1:1'] as Aspect[])('%s: khối luôn nằm trọn khung, kể cả câu rất dài và chữ lớn có viền, bóng, hộp', (aspect) => {
    const heavy = config({
      aspect,
      font: { family: 'montserrat', size: 160, weight: 800 },
      stroke: { enabled: true, color: '#000000', width: 20 },
      shadow: { enabled: true, color: '#000000', blur: 40 },
      box: { enabled: true, color: '#000000', radius: 60, opacity: 80 },
      maxWidthPct: 100,
    });
    for (const n of [1, 10, 60, 400, 2000]) {
      for (const pos of [0, 50, 100]) {
        const c = { ...heavy, position: { anchor: 'center' as const, y: pos } };
        expectInside(layoutCue(Array(n).fill('phượng').join(' '), c, m), c);
      }
    }
  });

  it('câu không vừa được thu nhỏ riêng, có thể nhỏ hơn 24 (FR-015); câu vừa thì giữ cỡ', () => {
    const short = layoutCue('Ngắn gọn', config(), m);
    expect(short).toMatchObject({ fontSize: 72, shrunk: false });
    const huge = layoutCue(Array(3000).fill('phượng').join(' '), config(), m);
    expect(huge.shrunk).toBe(true);
    expect(huge.fontSize).toBeLessThan(24);
    expect(huge.fontSize).toBeGreaterThanOrEqual(1);
  });
});

describe('ký tự thiếu', () => {
  const cov = coverage();
  it('tiếng Việt và chữ Kirin (phông chữ thay thế) đều có; emoji và chữ Hán bị báo một lần', () => {
    expect(missingChars('Được rồi, 100% nhé! “Đúng”', 'be-vietnam-pro', 700, cov)).toEqual([]);
    expect(missingChars('Привет', 'be-vietnam-pro', 700, cov)).toEqual([]);
    expect(missingChars('Tuyệt 😀😀 中文', 'be-vietnam-pro', 700, cov)).toEqual(['😀', '中', '文']);
  });
});
