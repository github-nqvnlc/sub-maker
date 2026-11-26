'use client';

import { useEffect, useState } from 'react';
import { cueIndexAt } from '@/lib/video/cue-ops';
import type { Cue } from '@/lib/video/types';

/** Đọc đồng hồ của phần tử phát: theo sự kiện, và theo từng khung khi đang phát (spec 006, FR-022). */
function subscribeClock(media: HTMLMediaElement, update: (ms: number) => void): () => void {
  let raf = 0;
  const read = () => update(media.currentTime * 1000);
  const loop = () => {
    read();
    if (!media.paused && !media.ended) raf = requestAnimationFrame(loop);
  };
  const kick = () => {
    cancelAnimationFrame(raf);
    loop();
  };
  const events = ['play', 'pause', 'seeking', 'seeked', 'timeupdate', 'ended', 'loadedmetadata', 'emptied'] as const;
  for (const e of events) media.addEventListener(e, kick);
  kick();
  return () => {
    cancelAnimationFrame(raf);
    for (const e of events) media.removeEventListener(e, kick);
  };
}

/** Chỉ số cue đang phát (-1: khoảng trống). Chỉ vẽ lại khi chỉ số đổi. */
export function useActiveCue(mediaRef: React.RefObject<HTMLMediaElement | null>, cues: readonly Cue[]): number {
  const [active, setActive] = useState(-1);
  useEffect(() => {
    const media = mediaRef.current;
    if (!media) return;
    return subscribeClock(media, (ms) => setActive(cueIndexAt(cues, ms)));
  }, [mediaRef, cues]);
  return active;
}

/** Mốc đang phát, làm tròn tới 100 ms để không vẽ lại ở mỗi khung. */
export function useMediaTime(mediaRef: React.RefObject<HTMLMediaElement | null>): number {
  const [time, setTime] = useState(0);
  useEffect(() => {
    const media = mediaRef.current;
    if (!media) return;
    return subscribeClock(media, (ms) => setTime(Math.round(ms / 100) * 100));
  }, [mediaRef]);
  return time;
}
