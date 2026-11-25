import { describe, expect, it } from 'vitest';
import type { Enter, OverlayConfig } from '@/lib/overlay/config';
import { colorWarnings } from '@/lib/overlay/colors';
import { cueEffect, GLITCH_MS, isExclaim } from '@/lib/overlay/effects';
import type { AppliedCue } from '@/lib/overlay/types';
import { boundsWhere, config, cue, notGreen, render, sameFrame, sceneOf } from './helpers';

/** Hiệu ứng câu nhóm điện ảnh (spec 005, FR-021, T089). */
const MS = 300;
const CUE: AppliedCue = cue({ startMs: 1000, endMs: 4000, text: 'Bất ngờ lớn' });
const SHOUT: AppliedCue = cue({ ...CUE, text: 'Bất ngờ lớn!' });
const cfg = (over: Partial<OverlayConfig>) => config({ effectMs: MS, ...over });

function at(over: Partial<OverlayConfig>, elapsed: number, c: AppliedCue = CUE) {
  const full = cfg(over);
  const scene = sceneOf(full, [c]);
  return cueEffect(full, c, scene.layoutOf(0), scene, c.startMs + elapsed);
}
const NEUTRAL = { alpha: 1, dx: 0, dy: 0, scaleX: 1, scaleY: 1, blur: 0, glow: 0, glitch: 0, settled: true };

describe('giật tách màu', () => {
  it('chỉ 100 ms đầu, bất kể thời lượng hiệu ứng đã chọn', () => {
    for (const effectMs of [100, 600]) {
      expect(at({ enter: 'glitch', effectMs }, 0).glitch).not.toBe(0);
      expect(at({ enter: 'glitch', effectMs }, GLITCH_MS - 1).settled).toBe(false);
      expect(at({ enter: 'glitch', effectMs }, GLITCH_MS)).toMatchObject(NEUTRAL);
    }
  });

  it('tách thành bản đỏ và lam lệch nhau; hết hiệu ứng thì như câu thường', () => {
    const scene = sceneOf(cfg({ enter: 'glitch', background: 'black', stroke: { enabled: false, color: '#000000', width: 6 } }), [CUE]);
    const f = render(scene, 1000);
    expect(boundsWhere(f, (r, g, b) => r > 120 && b < 90 && g < 90), 'có vùng đỏ').not.toBeNull();
    expect(boundsWhere(f, (r, g, b) => b > 120 && r < 90), 'có vùng lam').not.toBeNull();
    const still = sceneOf(cfg({ enter: 'cut', background: 'black', stroke: { enabled: false, color: '#000000', width: 6 } }), [CUE]);
    expect(sameFrame(render(scene, 2000), render(still, 2000))).toBe(true);
  });
});

describe('rung', () => {
  it('phạm vi "câu cảm thán": chỉ câu kết thúc bằng dấu chấm than', () => {
    expect(isExclaim('Đi thôi!')).toBe(true);
    expect(isExclaim('“Đi thôi!”')).toBe(true);
    expect(isExclaim('Đi thôi！ ')).toBe(true);
    expect(isExclaim('Đi! Rồi thôi.')).toBe(false);
    expect(isExclaim('Đi thôi?')).toBe(false);
    expect(at({ enter: 'shake', shakeScope: 'exclaim' }, 500)).toMatchObject(NEUTRAL);
    const s = at({ enter: 'shake', shakeScope: 'exclaim' }, 500, SHOUT);
    expect(s.settled).toBe(false);
    expect(Math.abs(s.dx) + Math.abs(s.dy)).toBeGreaterThan(0);
  });

  it('phạm vi "mọi câu": câu thường cũng rung suốt câu, biên độ theo cường độ', () => {
    const amp = (intensity: OverlayConfig['intensity']) =>
      Math.max(...Array.from({ length: 80 }, (_, k) => Math.abs(at({ enter: 'shake', shakeScope: 'all', intensity }, k * 34).dx)));
    expect(amp('low')).toBeGreaterThan(0);
    expect(amp('low')).toBeLessThanOrEqual(2);
    expect(amp('high')).toBeGreaterThan(amp('low'));
    expect(amp('high')).toBeLessThanOrEqual(7);
    expect(at({ enter: 'shake', shakeScope: 'all' }, 2900).settled).toBe(false);
  });
});

describe('lật 3D, nhòe, phát sáng', () => {
  it('flip3d: co dọc từ gần 0 về 1 quanh trục ngang; bề ngang không đổi', () => {
    expect(at({ enter: 'flip3d' }, 0).scaleY).toBeLessThan(0.05);
    const ys = Array.from({ length: 21 }, (_, k) => at({ enter: 'flip3d' }, (MS * k) / 20).scaleY);
    for (let i = 1; i < ys.length; i++) expect(ys[i]!).toBeGreaterThanOrEqual(ys[i - 1]!);
    expect(at({ enter: 'flip3d' }, MS)).toMatchObject(NEUTRAL);
    expect(at({ enter: 'flip3d' }, 100).scaleX).toBe(1);
    const scene = sceneOf(cfg({ enter: 'flip3d' }), [CUE]);
    const a = boundsWhere(render(scene, 1030), notGreen)!;
    const b = boundsWhere(render(scene, 2000), notGreen)!;
    expect(a.h).toBeLessThan(b.h);
    expect(Math.abs(a.w - b.w)).toBeLessThanOrEqual(4);
    expect(Math.abs(a.cy - b.cy)).toBeLessThanOrEqual(3);
  });

  it('blurIn: nhòe rộng hơn chữ rồi nét dần về đúng câu thường', () => {
    expect(at({ enter: 'blurIn' }, 0)).toMatchObject({ blur: 1, alpha: 0 });
    expect(at({ enter: 'blurIn' }, MS)).toMatchObject(NEUTRAL);
    const opts = { stroke: { enabled: false, color: '#000000', width: 6 } };
    const scene = sceneOf(cfg({ enter: 'blurIn', background: 'black', ...opts }), [CUE]);
    const soft = boundsWhere(render(scene, 1090), (r, g, b) => r + g + b > 12)!;
    const sharp = boundsWhere(render(scene, 2000), (r, g, b) => r + g + b > 12)!;
    expect(soft.w).toBeGreaterThan(sharp.w);
    expect(soft.h).toBeGreaterThan(sharp.h);
    const still = sceneOf(cfg({ enter: 'cut', background: 'black', ...opts }), [CUE]);
    expect(sameFrame(render(scene, 2000), render(still, 2000))).toBe(true);
  });

  it('glow: quầng sáng màu nổi bật ở khung đầu, tắt hẳn khi hết hiệu ứng', () => {
    expect(at({ enter: 'glow' }, 0).glow).toBe(1);
    expect(at({ enter: 'glow' }, MS)).toMatchObject(NEUTRAL);
    const over = { enter: 'glow' as Enter, background: 'black' as const, highlightColor: '#FF4500', stroke: { enabled: false, color: '#000000', width: 6 } };
    const scene = sceneOf(cfg(over), [CUE]);
    const orange = (t: number) => boundsWhere(render(scene, t), (r, g, b) => r > 60 && r > g * 2 && b < 40)?.count ?? 0;
    expect(orange(1010)).toBeGreaterThan(500);
    expect(orange(2000)).toBe(0);
  });
});

describe('tính chất chung', () => {
  const ENTERS: Enter[] = ['blurIn', 'glitch', 'glow', 'flip3d', 'shake'];

  it.each(ENTERS)('%s: cùng đầu vào cho cùng điểm ảnh', (enter) => {
    const c = cfg({ enter, shakeScope: 'all' });
    for (const t of [1000, 1033, 1067, 1150, 2000]) expect(sameFrame(render(sceneOf(c, [CUE]), t), render(sceneOf(c, [CUE]), t))).toBe(true);
  });

  it.each(ENTERS)('%s: thứ tự vẽ các khung không ảnh hưởng kết quả (tua trong xem trước giống dựng tuần tự)', (enter) => {
    const c = cfg({ enter, shakeScope: 'all' });
    const cues = [CUE, cue({ i: 1, startMs: 4000, endMs: 6000, readEndMs: 6000, text: 'Câu sau' })];
    const forward = sceneOf(c, cues);
    const jump = sceneOf(c, cues);
    const order = [1000, 1080, 2500, 4020, 4100];
    const seq = new Map(order.map((t) => [t, render(forward, t)]));
    for (const t of [...order].reverse()) expect(sameFrame(render(jump, t), seq.get(t)!)).toBe(true);
  });

  it.each(ENTERS)('%s trên nền trong suốt: ngoài vùng chữ trong suốt hẳn', (enter) => {
    const scene = sceneOf(cfg({ enter, background: 'transparent', format: 'mov', shakeScope: 'all' }), [CUE]);
    const f = render(scene, 1060);
    for (const [x, y] of [[0, 0], [1079, 1919], [540, 300]] as const) expect(f.data[(y * f.width + x) * 4 + 3]).toBe(0);
  });

  it('cảnh báo vùng bán trong suốt đúng cho từng hiệu ứng trên phông xanh', () => {
    const soft = (enter: Enter) => colorWarnings(cfg({ enter })).some((w) => w.code === 'SOFT_EDGE');
    expect(ENTERS.filter(soft)).toEqual(['blurIn', 'glitch', 'glow']);
    expect(colorWarnings(cfg({ enter: 'blurIn', background: 'transparent', format: 'mov' })).some((w) => w.code === 'SOFT_EDGE')).toBe(false);
  });

  it('câu ngắn hơn 100 ms vẫn giật tách màu trong khoảng của câu', () => {
    const short = cue({ startMs: 1000, endMs: 1060, readEndMs: 1060 });
    for (let t = 0; t < 60; t += 5) expect(Number.isFinite(at({ enter: 'glitch' }, t, short).dx)).toBe(true);
  });
});
