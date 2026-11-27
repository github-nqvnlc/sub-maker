'use client';

import { useEffect, useState } from 'react';
import { createLayer, type FontStatus } from '@/lib/hooks/use-overlay-canvas';
import { measureWith } from '@/lib/overlay/draw';
import { layoutCue } from '@/lib/overlay/layout';
import { boxHitsZone, type SafePlatform } from '@/lib/video/safe-zones';
import { toAppliedCues, toSceneStyle, type VideoStyle } from '@/lib/video/style';
import type { Cue } from '@/lib/video/types';

/** Chờ ngừng chỉnh rồi mới kiểm; kiểm theo từng mẻ để không làm khựng trang với kịch bản dài. */
const DEBOUNCE_MS = 300;
const CHUNK = 200;

type Result = { platform: SafePlatform; hits: number[] };

/**
 * Số thứ tự (từ 1) của các đoạn phụ đề có chữ lấn vào vùng bị che của một mạng xã hội trên khung 9:16 (spec 006, FR-030);
 * `null` khi chưa có kết quả cho mạng đang chọn. Trong lúc tính lại thì giữ kết quả trước để cảnh báo không chớp.
 */
export function useSafeZoneHits(platform: SafePlatform | null, style: VideoStyle, cues: readonly Cue[], fonts: FontStatus): number[] | null {
  const [result, setResult] = useState<Result | null>(null);

  useEffect(() => {
    if (!platform || fonts !== 'ready') return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const frame = { width: 1080, height: 1920 };
    const scene = toSceneStyle(style, frame.width, frame.height);
    const measure = measureWith(createLayer(8, 8).ctx);
    const hits: number[] = [];
    const step = (from: number) => {
      if (!alive) return;
      for (let i = from; i < Math.min(from + CHUNK, cues.length); i++) {
        const [shown] = toAppliedCues([cues[i]!], style.display);
        if (!shown) continue;
        const l = layoutCue(shown.text, scene, measure, shown.secondary);
        const box = { x: l.box.x - l.bleed, y: l.box.y - l.bleed, width: l.box.width + 2 * l.bleed, height: l.box.height + 2 * l.bleed };
        if (boxHitsZone(box, frame, platform)) hits.push(i + 1);
      }
      if (from + CHUNK < cues.length) timer = setTimeout(() => step(from + CHUNK));
      else setResult({ platform, hits });
    };
    timer = setTimeout(() => step(0), DEBOUNCE_MS);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [platform, style, cues, fonts]);

  return result && result.platform === platform ? result.hits : null;
}
