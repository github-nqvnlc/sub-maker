import { describe, expect, it } from 'vitest';
import { boxHitsZone, isVerticalFrame, SAFE_PLATFORMS, SAFE_ZONES } from '@/lib/video/safe-zones';
import { DEFAULT_VIDEO_STYLE, parseStoredStyle, toAppliedCues, toSceneStyle, videoStyleSchema, type VideoStyle } from '@/lib/video/style';

/** Kiểu phụ đề của dịch video (spec 006, T093; FR-026..FR-031). Độ đậm 600 và phông mới kiểm ở T095. */

const style = (over: Partial<VideoStyle> = {}): VideoStyle => ({ ...structuredClone(DEFAULT_VIDEO_STYLE), ...over });
const cue = (sourceText: string, targetText: string, startMs = 0) => ({ startMs, endMs: startMs + 1000, sourceText, targetText });

describe('chế độ hiển thị (FR-026)', () => {
  const cues = [cue('Hello there', 'Xin chào', 0), cue('Not translated yet', '  ', 2000), cue('Anna', 'Anna', 4000), cue('', 'Chỉ có bản dịch', 6000), cue(' ', ' ', 8000)];

  it('chỉ bản dịch (mặc định): đoạn chưa dịch dùng câu gốc, không có dòng thứ hai', () => {
    expect(DEFAULT_VIDEO_STYLE.display).toBe('target');
    expect(toAppliedCues(cues, 'target').map((c) => [c.text, c.secondary])).toEqual([
      ['Xin chào', undefined],
      ['Not translated yet', undefined],
      ['Anna', undefined],
      ['Chỉ có bản dịch', undefined],
    ]);
  });

  it('song ngữ: bản dịch là khối chính, câu gốc là dòng thứ hai; không lặp lại khi hai câu giống nhau hoặc thiếu một câu', () => {
    expect(toAppliedCues(cues, 'bilingual').map((c) => [c.text, c.secondary])).toEqual([
      ['Xin chào', 'Hello there'],
      ['Not translated yet', undefined],
      ['Anna', undefined],
      ['Chỉ có bản dịch', undefined],
    ]);
  });

  it('chỉ bản gốc: bỏ cue không có câu gốc', () => {
    expect(toAppliedCues(cues, 'source').map((c) => [c.text, c.secondary])).toEqual([
      ['Hello there', undefined],
      ['Not translated yet', undefined],
      ['Anna', undefined],
    ]);
  });

  it('chữ được chuẩn hóa NFC và đánh số liên tục', () => {
    const out = toAppliedCues([cue('café', 'cà phê', 0), cue('', '', 1500), cue('b', 'B', 3000)], 'bilingual');
    expect(out.map((c) => c.i)).toEqual([0, 1]);
    expect(out[0]).toMatchObject({ text: 'cà phê', secondary: 'café' });
  });
});

describe('đổi sang kiểu cảnh của bộ vẽ (FR-027..FR-029)', () => {
  it('giữ khoảng cách, độ đậm của bóng và cỡ, màu, độ mờ của dòng gốc', () => {
    const s = style({
      display: 'bilingual',
      shadow: { enabled: true, color: '#112233', blur: 6, distance: 14, opacity: 35 },
      sourceLine: { size: 28, color: '#ABCDEF', opacity: 40 },
    });
    const scene = toSceneStyle(s, 720, 1280);
    expect(scene.shadow).toEqual({ enabled: true, color: '#112233', blur: 6, distance: 14, opacity: 35 });
    expect(scene.secondary).toEqual({ size: 28, color: '#ABCDEF', opacity: 40 });
    expect(scene.k).toBeCloseTo(2 / 3, 6);
  });

  it('khóa lạ và giá trị ngoài khoảng bị từ chối; kiểu lưu hỏng thì về mặc định', () => {
    for (const bad of [
      style({ shadow: { enabled: true, color: '#000000', blur: 6, distance: 21, opacity: 35 } }),
      style({ sourceLine: { size: 15, color: '#FFFFFF', opacity: 50 } }),
      style({ maxWidthPct: 39 }),
      { ...style(), extra: 1 },
    ]) {
      expect(videoStyleSchema.safeParse(bad).success).toBe(false);
    }
    expect(parseStoredStyle({ display: 'x' })).toEqual(DEFAULT_VIDEO_STYLE);
  });
});

describe('vùng an toàn (FR-030)', () => {
  const frame = { width: 1080, height: 1920 };

  it('mỗi mạng có vùng nằm trong khung', () => {
    expect([...SAFE_PLATFORMS]).toEqual(['tiktok', 'shorts', 'reels']);
    for (const p of SAFE_PLATFORMS) {
      expect(SAFE_ZONES[p].length).toBeGreaterThan(0);
      for (const z of SAFE_ZONES[p]) {
        expect(z.x).toBeGreaterThanOrEqual(0);
        expect(z.y).toBeGreaterThanOrEqual(0);
        expect(z.width).toBeGreaterThan(0);
        expect(z.height).toBeGreaterThan(0);
        expect(z.x + z.width).toBeLessThanOrEqual(100);
        expect(z.y + z.height).toBeLessThanOrEqual(100);
      }
    }
  });

  it('chỉ áp dụng cho khung 9:16', () => {
    expect(isVerticalFrame(1080, 1920)).toBe(true);
    expect(isVerticalFrame(720, 1280)).toBe(true);
    expect(isVerticalFrame(1920, 1080)).toBe(false);
    expect(isVerticalFrame(1080, 1080)).toBe(false);
    expect(isVerticalFrame(1080, 1350)).toBe(false);
  });

  it.each(SAFE_PLATFORMS)('%s: chữ sát đáy bị lấn, chữ giữa khung thì không', (p) => {
    expect(boxHitsZone({ x: 200, y: 1800, width: 600, height: 80 }, frame, p)).toBe(true);
    expect(boxHitsZone({ x: 200, y: 700, width: 600, height: 80 }, frame, p)).toBe(false);
    // cùng hình ở khung nhỏ hơn cho cùng kết quả
    expect(boxHitsZone({ x: 100, y: 900, width: 300, height: 40 }, { width: 540, height: 960 }, p)).toBe(true);
  });

  it('chạm mép vùng chưa tính là lấn', () => {
    const z = SAFE_ZONES.tiktok[0]!;
    const px = { x: (z.x / 100) * frame.width, y: (z.y / 100) * frame.height, width: (z.width / 100) * frame.width, height: (z.height / 100) * frame.height };
    const below = { x: px.x, y: px.y + px.height, width: 10, height: 10 };
    expect(boxHitsZone(below, frame, 'tiktok')).toBe(false);
    expect(boxHitsZone({ ...below, y: below.y - 2 }, frame, 'tiktok')).toBe(true);
  });
});
