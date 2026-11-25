import { describe, expect, it } from 'vitest';
import type { Intensity, OverlayConfig } from '@/lib/overlay/config';
import { wordStates } from '@/lib/overlay/effects';
import type { AppliedCue } from '@/lib/overlay/types';
import { wordSpans } from '@/lib/overlay/words';
import { boundsWhere, config, cue, isWhite, notGreen, render, sameFrame, sceneOf, type Frame } from './helpers';

/** Hiệu ứng theo từng từ và karaoke (spec 005, FR-022, FR-023, FR-025, T069). */
const CUE: AppliedCue = cue({ startMs: 1000, endMs: 4000, readEndMs: 3500, text: 'Nguyễn Huệ tiến quân ra Thăng Long.' });
const SPANS = wordSpans(CUE);
const cfg = (over: Partial<OverlayConfig>) => config({ effectMs: 200, ...over });
const states = (over: Partial<OverlayConfig>, t: number) => wordStates(cfg(over), CUE, SPANS, t);
const isYellow = (r: number, g: number, b: number) => r > 240 && g > 215 && g < 240 && b < 60;

describe('theo từng từ', () => {
  const word = { sync: 'word', wordEffect: 'cut' } as const;

  it('cut: từ thứ i hiện đúng lúc bắt đầu, đã hiện thì ở lại tới hết câu', () => {
    SPANS.forEach((s, i) => {
      expect(states(word, s.startMs - 1).states[i]!.visible).toBe(false);
      expect(states(word, s.startMs).states[i]!.visible).toBe(true);
      expect(states(word, 3999).states[i]!.visible).toBe(true);
    });
    expect(states(word, 1000).states.filter((x) => x.visible)).toHaveLength(1);
  });

  it('chỗ của từ chưa hiện vẫn được giữ: từ đã hiện không nhảy vị trí', () => {
    const scene = sceneOf(cfg({ ...word, stroke: { enabled: false, color: '#000000', width: 6 } }), [CUE]);
    const first = boundsWhere(render(scene, SPANS[0]!.startMs), isWhite)!;
    const all = render(scene, 3900);
    // từ đầu của khung đầy đủ nằm đúng chỗ của từ đầu lúc mới hiện
    let same = 0;
    let total = 0;
    const one = render(scene, SPANS[0]!.startMs);
    for (let y = first.y0; y <= first.y1; y++) {
      for (let x = first.x0; x <= first.x1; x++) {
        const o = (y * one.width + x) * 4;
        total++;
        if (one.data[o] === all.data[o] && one.data[o + 2] === all.data[o + 2]) same++;
      }
    }
    expect(same / total).toBeGreaterThan(0.999);
  });

  it('pop: từ mới nảy lên rồi đứng yên; từ ngắn hơn thời lượng hiệu ứng thì rút ngắn', () => {
    const over = { sync: 'word', wordEffect: 'pop', effectMs: 600 } as const;
    const s = SPANS[2]!;
    expect(states(over, s.startMs).states[2]!.scale).toBeCloseTo(0.6, 5);
    const scales = Array.from({ length: 60 }, (_, k) => states(over, s.startMs + ((SPANS[3]!.startMs - s.startMs) * k) / 60).states[2]!.scale);
    expect(Math.max(...scales)).toBeGreaterThan(1.02);
    // tới lúc từ kế bắt đầu thì từ này đã đứng yên
    expect(states(over, SPANS[3]!.startMs).states[2]!.scale).toBe(1);
    expect(states(over, s.startMs + 1).key).toBeNull();
    expect(states(over, 3999).key).not.toBeNull();
  });

  it('typewriter: hiện dần từng cụm ký tự, không tách dấu tiếng Việt; hết khoảng của từ thì đủ chữ', () => {
    const over = { sync: 'word', wordEffect: 'typewriter' } as const;
    const s = SPANS[0]!; // "Nguyễn": 6 cụm
    const seen = new Set<number>();
    for (let t = s.startMs; t < s.endMs; t++) {
      const n = states(over, t).states[0]!.chars;
      if (n !== null) seen.add(n);
    }
    expect([...seen]).toEqual([1, 2, 3, 4, 5]);
    expect(states(over, s.endMs).states[0]!.chars).toBeNull();

    // chữ tách dấu (NFD) vẫn đếm theo cụm hiển thị
    const nfd = cue({ ...CUE, text: 'ễ ệ ậ'.normalize('NFD') });
    const spans = wordSpans(nfd);
    expect(spans.map((x) => x.text)).toEqual(['ễ', 'ệ', 'ậ']);
    expect(wordStates(cfg(over), nfd, spans, spans[0]!.startMs).states[0]!.chars).toBeNull();
  });

  it('typewriter: phần chữ đã gõ không xê dịch khi gõ thêm', () => {
    const scene = sceneOf(cfg({ sync: 'word', wordEffect: 'typewriter', stroke: { enabled: false, color: '#000000', width: 6 } }), [CUE]);
    const s = SPANS[0]!;
    const early = boundsWhere(render(scene, s.startMs + (s.endMs - s.startMs) * 0.4), isWhite)!;
    const late = boundsWhere(render(scene, s.endMs), isWhite)!;
    expect(Math.abs(early.x0 - late.x0)).toBeLessThanOrEqual(1);
    expect(late.x1).toBeGreaterThan(early.x1);
  });

  it('không có chữ nào trước câu; sau khoảng đọc câu vẫn còn đủ', () => {
    const scene = sceneOf(cfg(word), [CUE]);
    expect(render(scene, 999).key).toBe('bg');
    const read = render(scene, 3500);
    const after = render(scene, 3990);
    expect(after.key).toBe(read.key);
    expect(sameFrame(read, after)).toBe(true);
  });
});

describe('karaoke', () => {
  it.each([
    ['low', 1.15],
    ['medium', 1.18],
    ['high', 1.2],
  ] as Array<[Intensity, number]>)('active %s: nhiều nhất một từ nổi bật, phóng %f, đổi màu', (intensity, scale) => {
    const over = { sync: 'karaoke', wordEffect: 'active', intensity } as const;
    for (let t = 900; t < 4000; t += 7) {
      const on = states(over, t).states.filter((x) => x.highlight);
      expect(on.length).toBeLessThanOrEqual(1);
      for (const x of states(over, t).states) expect(x.visible).toBe(true);
    }
    const s = SPANS[3]!;
    const st = states(over, s.endMs - 1).states;
    expect(st.findIndex((x) => x.highlight)).toBe(3);
    expect(st[3]!.scale).toBeCloseTo(scale, 3);
    expect(st.filter((_, i) => i !== 3).every((x) => x.scale === 1)).toBe(true);
  });

  it('active: hết khoảng đọc thì không từ nào nổi bật dù câu còn hiện', () => {
    const over = { sync: 'karaoke', wordEffect: 'active' } as const;
    expect(states(over, 3499).states.some((x) => x.highlight)).toBe(true);
    expect(states(over, 3500).states.some((x) => x.highlight)).toBe(false);
    expect(states(over, 3990).key).toBe(states(over, 3500).key);
  });

  it('active: đổi từ nổi bật không làm đổi vị trí các từ khác', () => {
    const scene = sceneOf(cfg({ sync: 'karaoke', wordEffect: 'active' }), [CUE]);
    const yellow = (f: Frame) => boundsWhere(f, isYellow);
    const a = yellow(render(scene, SPANS[0]!.endMs - 1))!;
    const b = yellow(render(scene, SPANS[2]!.endMs - 1))!;
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a.x0 === b.x0 && a.y0 === b.y0).toBe(false);
    const layout = scene.layoutOf(0);
    expect(scene.layoutOf(0)).toBe(layout);
    expect(yellow(render(scene, 3600))).toBeNull();
  });

  it('wipe: tăng dần, từ đã đọc giữ màu, đọc xong thì phủ hết cả câu', () => {
    const over = { sync: 'karaoke', wordEffect: 'wipe' } as const;
    let prev = -1;
    for (let t = 1000; t <= 3500; t += 10) {
      const sum = states(over, t).states.reduce((x, s) => x + s.wipe, 0);
      expect(sum).toBeGreaterThanOrEqual(prev);
      prev = sum;
      for (const s of states(over, t).states) expect(s.wipe).toBeGreaterThanOrEqual(0);
    }
    expect(states(over, 1000).states.every((s) => s.wipe === 0)).toBe(true);
    expect(states(over, 3500).states.every((s) => s.wipe === 1)).toBe(true);

    const scene = sceneOf(cfg({ ...over, stroke: { enabled: false, color: '#000000', width: 6 } }), [CUE]);
    const start = render(scene, 1000);
    expect(boundsWhere(start, isYellow)).toBeNull();
    const done = render(scene, 3600);
    expect(boundsWhere(done, isWhite)).toBeNull();
    const half = render(scene, (SPANS[3]!.startMs + SPANS[3]!.endMs) / 2);
    expect(boundsWhere(half, isYellow)!.count).toBeGreaterThan(1000);
    expect(boundsWhere(half, isWhite)!.count).toBeGreaterThan(1000);
  });

  it('kết hợp được với hiệu ứng vào của cả câu', () => {
    const scene = sceneOf(cfg({ sync: 'karaoke', wordEffect: 'active', enter: 'pop', intensity: 'low' }), [CUE]);
    const first = boundsWhere(render(scene, 1000), notGreen)!;
    const later = boundsWhere(render(scene, 2000), notGreen)!;
    expect(first.w).toBeLessThan(later.w * 0.95);
  });

  it('khung xem trước và video dùng cùng mốc: dựng cảnh hai lần cho cùng khung', () => {
    const c = cfg({ sync: 'karaoke', wordEffect: 'wipe' });
    const other = cue({ ...CUE, i: 1, startMs: 4000, endMs: 6000, readEndMs: 6000, text: 'Câu kế tiếp' });
    const one = sceneOf(c, [CUE, other]);
    const two = sceneOf(c, [CUE, other]);
    for (const t of [1234, 2345, 3456, 4567]) expect(sameFrame(render(one, t), render(two, t))).toBe(true);
  });
});
