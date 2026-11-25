import { describe, expect, it } from 'vitest';
import type { Enter, Intensity, OverlayConfig } from '@/lib/overlay/config';
import { cueEffect, effectDurations, type EffectState } from '@/lib/overlay/effects';
import type { AppliedCue } from '@/lib/overlay/types';
import { boundsWhere, config, cue, notGreen, render, sameFrame, sceneOf } from './helpers';

/** Hiệu ứng câu nhóm cơ bản và động lực (spec 005, FR-019, FR-020, FR-027, T064). */
const MS = 300;
const CUE: AppliedCue = cue({ startMs: 1000, endMs: 4000 });
const cfg = (over: Partial<OverlayConfig> = {}) => config({ effectMs: MS, ...over });

function at(over: Partial<OverlayConfig>, elapsed: number, c: AppliedCue = CUE): EffectState & { fs: number; left: number; right: number; width: number } {
  const full = cfg(over);
  const scene = sceneOf(full, [c]);
  const layout = scene.layoutOf(0);
  const s = cueEffect(full, c, layout, scene, c.startMs + elapsed);
  return { ...s, fs: layout.fontSize, left: layout.box.x, right: layout.box.x + layout.box.width, width: scene.width };
}
const samples = (over: Partial<OverlayConfig>, n = 300) => Array.from({ length: n + 1 }, (_, i) => at(over, (MS * i) / n));
const NEUTRAL = { alpha: 1, dx: 0, dy: 0, scaleX: 1, scaleY: 1, blur: 0, glow: 0, glitch: 0, settled: true };

describe('hiệu ứng vào', () => {
  it('cut: đầy đủ ngay từ khung đầu', () => {
    expect(at({ enter: 'cut' }, 0)).toMatchObject(NEUTRAL);
  });

  it('fade: độ đục 0 → 1 đều', () => {
    expect(at({ enter: 'fade' }, 0).alpha).toBe(0);
    expect(at({ enter: 'fade' }, MS / 2).alpha).toBeCloseTo(0.5, 5);
    expect(at({ enter: 'fade' }, MS)).toMatchObject(NEUTRAL);
  });

  it.each([
    ['low', 1],
    ['medium', 1.02],
    ['high', 1.04],
  ] as Array<[Intensity, number]>)('pop %s: 80%% → đỉnh %f → 100%%', (intensity, peak) => {
    const over = { enter: 'pop' as Enter, intensity };
    expect(at(over, 0).scaleX).toBeCloseTo(0.8, 5);
    expect(Math.max(...samples(over).map((s) => s.scaleX))).toBeCloseTo(peak, 3);
    expect(at(over, MS)).toMatchObject(NEUTRAL);
    for (const s of samples(over, 20)) expect(s.scaleY).toBe(s.scaleX);
  });

  it.each([
    ['low', 1.03],
    ['medium', 1.05],
    ['high', 1.1],
  ] as Array<[Intensity, number]>)('bounce %s: đỉnh %f rồi dao động về 100%%', (intensity, peak) => {
    const all = samples({ enter: 'bounce', intensity });
    expect(all[0]!.scaleX).toBeCloseTo(0.8, 5);
    const max = Math.max(...all.map((s) => s.scaleX));
    expect(max).toBeCloseTo(peak, 3);
    const peakAt = all.findIndex((s) => s.scaleX === max);
    // sau đỉnh có hụt xuống dưới 100% (nảy) rồi mới đứng yên
    expect(Math.min(...all.slice(peakAt).map((s) => s.scaleX))).toBeLessThan(1);
    expect(at({ enter: 'bounce', intensity }, MS)).toMatchObject(NEUTRAL);
  });

  it('slideUp: từ dưới 0,8 cỡ chữ, chậm dần, kèm độ đục', () => {
    const s0 = at({ enter: 'slideUp' }, 0);
    expect(s0.dy).toBeCloseTo(0.8 * s0.fs, 5);
    expect(s0.alpha).toBe(0);
    const ys = samples({ enter: 'slideUp' }, 20).map((s) => s.dy);
    for (let i = 1; i < ys.length; i++) expect(ys[i]!).toBeLessThanOrEqual(ys[i - 1]!);
    // chậm dần: nửa đầu đi được hơn nửa quãng đường
    expect(ys[10]!).toBeLessThan(ys[0]! / 2);
    expect(at({ enter: 'slideUp' }, MS)).toMatchObject(NEUTRAL);
  });

  it('slideLeft và slideRight: khung đầu nằm hẳn ngoài khung hình, vào đúng phía', () => {
    const l = at({ enter: 'slideLeft' }, 0);
    expect(l.right + l.dx).toBeLessThanOrEqual(0);
    const r = at({ enter: 'slideRight' }, 0);
    expect(r.left + r.dx).toBeGreaterThanOrEqual(r.width);
    expect(at({ enter: 'slideLeft' }, MS / 2).dx).toBeLessThan(0);
    expect(at({ enter: 'slideRight' }, MS / 2).dx).toBeGreaterThan(0);
    expect(at({ enter: 'slideLeft' }, MS)).toMatchObject(NEUTRAL);
    expect(at({ enter: 'slideRight' }, MS)).toMatchObject(NEUTRAL);
  });

  it('dropDown: từ trên rơi xuống, có dằn lại', () => {
    const all = samples({ enter: 'dropDown' }).map((s) => s.dy);
    expect(all[0]!).toBeLessThan(0);
    // dằn: có lúc chạm vị trí cuối rồi nảy ngược lên
    const touch = all.findIndex((y) => y > -0.5);
    expect(touch).toBeGreaterThan(0);
    expect(Math.min(...all.slice(touch, all.length - 1))).toBeLessThan(-1);
    expect(at({ enter: 'dropDown' }, MS)).toMatchObject(NEUTRAL);
  });
});

describe('hiệu ứng ra', () => {
  it.each(['fade', 'slideDown'] as const)('%s: ẩn hẳn tại mốc kết thúc', (exit) => {
    expect(at({ exit }, 3000 - MS - 1)).toMatchObject(NEUTRAL);
    const mid = at({ exit }, 3000 - MS / 2);
    expect(mid.alpha).toBeCloseTo(0.5, 5);
    const end = at({ exit }, 3000);
    expect(end.alpha).toBeCloseTo(0, 5);
    if (exit === 'slideDown') {
      expect(mid.dy).toBeGreaterThan(0);
      expect(end.dy).toBeCloseTo(0.8 * end.fs, 5);
    } else expect(end.dy).toBe(0);
  });

  it('cut: giữ nguyên tới khung cuối', () => {
    expect(at({ exit: 'cut' }, 2999)).toMatchObject(NEUTRAL);
  });
});

describe('câu ngắn (FR-027)', () => {
  it('tổng vào + ra không vượt thời lượng câu; rút theo tỉ lệ', () => {
    const c = cfg({ enter: 'pop', exit: 'fade', effectMs: 600 });
    expect(effectDurations(c, 3000)).toEqual({ enter: 600, exit: 600 });
    expect(effectDurations(c, 1200)).toEqual({ enter: 600, exit: 600 });
    expect(effectDurations(c, 600)).toEqual({ enter: 300, exit: 300 });
    expect(effectDurations(cfg({ enter: 'glitch', exit: 'fade', effectMs: 300 }), 200)).toEqual({ enter: 50, exit: 150 });
    expect(effectDurations(cfg({ enter: 'slideUp', exit: 'cut', effectMs: 600 }), 100)).toEqual({ enter: 100, exit: 0 });
    expect(effectDurations(cfg({ enter: 'cut', exit: 'cut' }), 34)).toEqual({ enter: 0, exit: 0 });
  });

  it('câu 100 ms với hiệu ứng 600 ms: hiện trọn vẹn một lúc rồi ẩn hẳn, không lỗi số', () => {
    const short = cue({ startMs: 1000, endMs: 1100, readEndMs: 1100 });
    for (let t = 0; t <= 100; t += 5) {
      const s = at({ enter: 'bounce', exit: 'slideDown', effectMs: 600 }, t, short);
      for (const v of [s.alpha, s.dx, s.dy, s.scaleX, s.scaleY]) expect(Number.isFinite(v)).toBe(true);
    }
    expect(at({ enter: 'fade', exit: 'fade', effectMs: 600 }, 50, short).alpha).toBeCloseTo(1, 5);
    expect(at({ enter: 'fade', exit: 'fade', effectMs: 600 }, 100, short).alpha).toBeCloseTo(0, 5);
  });
});

describe('vẽ ra khung', () => {
  it('hết hiệu ứng vào thì các khung có cùng khóa và giống hệt nhau; đang chuyển động thì không có khóa', () => {
    const scene = sceneOf(cfg({ enter: 'bounce', exit: 'slideDown' }), [CUE]);
    const moving = render(scene, 1100);
    const a = render(scene, 1000 + MS);
    const b = render(scene, 3600);
    expect(moving.key).toBeNull();
    expect(a.key).not.toBeNull();
    expect(b.key).toBe(a.key);
    expect(sameFrame(a, b)).toBe(true);
    expect(sameFrame(moving, a)).toBe(false);
    expect(render(scene, 3900).key).toBeNull();
  });

  it('bung ra: khối chữ nhỏ dần về đúng cỡ; tâm khối không đổi', () => {
    const scene = sceneOf(cfg({ enter: 'pop', intensity: 'low' }), [CUE]);
    const first = boundsWhere(render(scene, 1000), notGreen)!;
    const last = boundsWhere(render(scene, 2000), notGreen)!;
    expect(first.w / last.w).toBeCloseTo(0.8, 1);
    expect(Math.abs(first.cx - last.cx)).toBeLessThanOrEqual(3);
    expect(Math.abs(first.cy - last.cy)).toBeLessThanOrEqual(3);
  });

  it('trượt từ trái: khung đầu không có điểm ảnh chữ nào trong khung hình', () => {
    const scene = sceneOf(cfg({ enter: 'slideLeft' }), [CUE]);
    expect(boundsWhere(render(scene, 1000), notGreen)).toBeNull();
    expect(boundsWhere(render(scene, 1000 + MS), notGreen)).not.toBeNull();
  });

  it('nền không đổi màu khi có chuyển động', () => {
    const scene = sceneOf(cfg({ enter: 'bounce' }), [CUE]);
    const f = render(scene, 1080);
    for (const [x, y] of [[0, 0], [1079, 0], [0, 1919], [540, 400]] as const) {
      const o = (y * f.width + x) * 4;
      expect([...f.data.slice(o, o + 4)]).toEqual([0, 255, 0, 255]);
    }
  });
});
