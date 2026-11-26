'use client';

import { useEffect, useMemo, useState } from 'react';
import { asCtx, createLayer, useFontStatus, type FontStatus } from '@/lib/hooks/use-overlay-canvas';
import { createScene, drawFrame, measureWith, type Scene } from '@/lib/overlay/draw';
import { activeCueIndex } from '@/lib/overlay/timing';
import { toAppliedCues, toSceneStyle, type VideoStyle } from '@/lib/video/style';
import type { Cue } from '@/lib/video/types';

/**
 * Phụ đề nổi trên khung xem trước (spec 006, contracts/render-and-media.md §5): cùng bộ vẽ với tiến trình xuất, `k` theo kích thước
 * hiển thị; chỉ vẽ lại khi khung đổi.
 */
export function useSubtitleCanvas(opts: {
  boxRef: React.RefObject<HTMLElement | null>;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  mediaRef: React.RefObject<HTMLVideoElement | null>;
  style: VideoStyle;
  cues: readonly Cue[];
}): { fonts: FontStatus } {
  const { boxRef, canvasRef, mediaRef, style, cues } = opts;
  const fonts = useFontStatus(style.font.family);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);

  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const measure = () => {
      const ratio = window.devicePixelRatio || 1;
      const width = Math.round(box.clientWidth * ratio);
      const height = Math.round(box.clientHeight * ratio);
      if (width < 2 || height < 2) return;
      setSize((old) => (old?.width === width && old.height === height ? old : { width, height }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    return () => observer.disconnect();
  }, [boxRef]);

  const applied = useMemo(() => toAppliedCues(cues, style.display), [cues, style.display]);
  const scene: Scene | null = useMemo(() => {
    if (fonts !== 'ready' || !size) return null;
    return createScene({ style: toSceneStyle(style, size.width, size.height), cues: applied, measure: measureWith(createLayer(8, 8).ctx), createLayer });
  }, [applied, style, size, fonts]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const media = mediaRef.current;
    if (!canvas || !media || !scene) return;
    canvas.width = scene.width;
    canvas.height = scene.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    // cả cue hiện cùng lúc, không hiệu ứng: khung chỉ đổi khi cue đổi
    const still = scene.style.sync === 'cue' && scene.style.enter === 'cut';
    let drawn: number | null = null;
    let raf = 0;
    let frame = 0;
    const draw = (seconds: number) => {
      const ms = seconds * 1000;
      const cue = activeCueIndex(scene.cues, ms);
      if (still && cue === drawn) return;
      drawn = cue;
      drawFrame(asCtx(ctx), ms, scene);
    };
    const byFrame = typeof media.requestVideoFrameCallback === 'function';
    // có hình thì `requestVideoFrameCallback` dẫn nhịp; chỉ có tiếng thì vẽ theo khung màn hình
    const loop = () => {
      draw(media.currentTime);
      if (!media.paused && !media.ended && !(byFrame && media.videoWidth > 0)) raf = requestAnimationFrame(loop);
    };
    const onVideoFrame: VideoFrameRequestCallback = (_now, meta) => {
      draw(meta.mediaTime);
      frame = media.requestVideoFrameCallback(onVideoFrame);
    };
    const kick = () => {
      cancelAnimationFrame(raf);
      loop();
    };
    if (byFrame) frame = media.requestVideoFrameCallback(onVideoFrame);
    kick();
    const events = ['play', 'pause', 'seeking', 'seeked', 'timeupdate', 'ended', 'loadedmetadata', 'emptied'] as const;
    for (const e of events) media.addEventListener(e, kick);
    return () => {
      cancelAnimationFrame(raf);
      if (byFrame) media.cancelVideoFrameCallback(frame);
      for (const e of events) media.removeEventListener(e, kick);
    };
  }, [scene, canvasRef, mediaRef]);

  return { fonts };
}
