'use client';

import { useEffect, useMemo, useState } from 'react';
import type { OverlayConfig } from '@/lib/overlay/config';
import { createScene, drawFrame, measureWith, type Ctx2D, type Layer, type Scene } from '@/lib/overlay/draw';
import { FONT_PUBLIC_PATH, fontFilesFor, missingChars, registeredName, type FontCoverage, type FontFamily } from '@/lib/overlay/fonts';
import type { AppliedCue, OverlayWarning } from '@/lib/overlay/types';

/**
 * Khung xem trước của video overlay (spec 005, FR-029..031): nạp đúng các tệp phông chữ của bộ dựng hình, vẽ bằng cùng `drawFrame` với
 * tiến trình xuất. `<canvas>` luôn ở KÍCH THƯỚC XUẤT và được co bằng CSS; không dùng `ctx.scale` vì độ mờ bóng không co theo (research R1).
 */

const faces = new Map<string, Promise<void>>();
function loadFace(family: string, weight: number, file: string): Promise<void> {
  const hit = faces.get(file);
  if (hit) return hit;
  const p = (async () => {
    const face = new FontFace(registeredName(family), `url(${FONT_PUBLIC_PATH}/${file})`, { weight: String(weight), style: 'normal', display: 'block' });
    document.fonts.add(await face.load());
  })();
  faces.set(file, p);
  // lần sau được thử lại nếu tải lỗi
  p.catch(() => faces.delete(file));
  return p;
}
const loadFamily = (family: FontFamily) => Promise.all(fontFilesFor(family).map((f) => loadFace(f.family, f.weight, f.file)));

let coverage: Promise<FontCoverage> | null = null;
const loadCoverage = () =>
  (coverage ??= fetch(`${FONT_PUBLIC_PATH}/coverage.json`).then((r) => {
    if (!r.ok) throw new Error('coverage');
    return r.json() as Promise<FontCoverage>;
  }));

export const asCtx = (c: CanvasRenderingContext2D): Ctx2D => c as unknown as Ctx2D;

export function createLayer(width: number, height: number): Layer {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return { canvas, ctx: asCtx(canvas.getContext('2d')!), width, height };
}

export type FontStatus = 'loading' | 'ready' | 'error';

export function useFontStatus(family: FontFamily): FontStatus {
  const [state, setState] = useState<{ family: FontFamily; status: FontStatus }>({ family, status: 'loading' });
  useEffect(() => {
    let alive = true;
    loadFamily(family).then(
      () => alive && setState({ family, status: 'ready' }),
      () => alive && setState({ family, status: 'error' }),
    );
    return () => {
      alive = false;
    };
  }, [family]);
  return state.family === family ? state.status : 'loading';
}

/** Vẽ chậm hơn mức này (ms) thì giảm số khung vẽ mỗi giây; không giảm kích thước. */
const SLOW_FRAME_MS = 24;

export function useOverlayCanvas(opts: {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  audioRef: React.RefObject<HTMLAudioElement | null>;
  config: OverlayConfig;
  cues: readonly AppliedCue[];
}): { fonts: FontStatus; warnings: OverlayWarning[] } {
  const { canvasRef, audioRef, config, cues } = opts;
  const fonts = useFontStatus(config.font.family);

  const scene: Scene | null = useMemo(() => {
    if (fonts !== 'ready') return null;
    return createScene({ config, cues, measure: measureWith(createLayer(8, 8).ctx), createLayer });
  }, [config, cues, fonts]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const audio = audioRef.current;
    if (!canvas || !audio || !scene) return;
    if (canvas.width !== scene.width) canvas.width = scene.width;
    if (canvas.height !== scene.height) canvas.height = scene.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    let raf = 0;
    let skip = false;
    const loop = () => {
      const playing = !audio.paused && !audio.ended;
      if (!skip || !playing) {
        const t0 = performance.now();
        drawFrame(asCtx(ctx), audio.currentTime * 1000, scene);
        skip = performance.now() - t0 > SLOW_FRAME_MS;
      } else skip = false;
      if (playing && !document.hidden) raf = requestAnimationFrame(loop);
    };
    const kick = () => {
      cancelAnimationFrame(raf);
      skip = false;
      raf = requestAnimationFrame(loop);
    };
    kick();
    const events = ['play', 'pause', 'seeking', 'seeked', 'timeupdate', 'ended', 'loadedmetadata'] as const;
    for (const e of events) audio.addEventListener(e, kick);
    document.addEventListener('visibilitychange', kick);
    return () => {
      cancelAnimationFrame(raf);
      for (const e of events) audio.removeEventListener(e, kick);
      document.removeEventListener('visibilitychange', kick);
    };
  }, [scene, canvasRef, audioRef]);

  // Cảnh báo cần đo chữ: câu bị thu nhỏ và ký tự thiếu (tính sau khi ngừng chỉnh để không giật khi kéo thanh trượt)
  const [warnings, setWarnings] = useState<OverlayWarning[]>([]);
  useEffect(() => {
    let alive = true;
    const timer = setTimeout(() => {
      void (async () => {
        if (!scene) return setWarnings([]);
        const out: OverlayWarning[] = [];
        const shrunk = cues.filter((_, i) => scene.layoutOf(i).shrunk).map((c) => c.i + 1);
        if (shrunk.length > 0) out.push({ code: 'CUE_SHRUNK', params: { count: shrunk.length, cues: shrunk.slice(0, 10).join(', ') + (shrunk.length > 10 ? '…' : '') } });
        const cov = await loadCoverage().catch(() => null);
        if (cov) {
          const missing = new Set(cues.flatMap((c) => missingChars(c.text, config.font.family, config.font.weight, cov)));
          if (missing.size > 0) out.push({ code: 'MISSING_GLYPH', params: { chars: [...missing].slice(0, 20).join(' ') } });
        }
        if (alive) setWarnings(out);
      })();
    }, 300);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [scene, cues, config.font.family, config.font.weight]);

  return { fonts, warnings };
}
