'use client';

import { useEffect, useRef, useState } from 'react';
import { findActiveIndex, segmentStartSeconds } from '@/lib/player/active-segment';
import { vi } from '@/lib/i18n/vi';
import { cn } from '@/lib/utils';

export type SyncedSegment = { idx: number; text: string; startMs: number; endMs: number };

/** Sau khi người dùng tự cuộn/chạm, tạm dừng tự cuộn trong khoảng này để không giật khi họ đang đọc chỗ khác. */
const USER_SCROLL_PAUSE_MS = 3500;

/**
 * Văn bản kịch bản đồng bộ với audio (FR-027, FR-028):
 * - làm nổi bật ĐÚNG đoạn đang đọc theo `currentTime` (vòng requestAnimationFrame + tìm nhị phân),
 * - tự cuộn để đoạn đó luôn ở giữa vùng nhìn (trừ khi người dùng đang tự cuộn),
 * - cập nhật ngay khi tua hoặc tạm dừng, và bấm vào một đoạn để phát từ đoạn đó.
 */
export function SyncedText({ audioRef, segments }: { audioRef: React.RefObject<HTMLAudioElement | null>; segments: SyncedSegment[] }) {
  const [active, setActive] = useState(0);
  const activeRef = useRef(0);
  const items = useRef<Array<HTMLButtonElement | null>>([]);
  const pausedScrollUntil = useRef(0);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || segments.length === 0) return;
    let raf = 0;
    const update = () => {
      const i = findActiveIndex(segments, audio.currentTime * 1000);
      if (i !== activeRef.current) {
        activeRef.current = i;
        setActive(i);
      }
    };
    const tick = () => {
      update();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    // Phòng khi rAF bị tạm dừng (tab nền): vẫn cập nhật theo sự kiện của audio
    audio.addEventListener('seeked', update);
    audio.addEventListener('timeupdate', update);
    return () => {
      cancelAnimationFrame(raf);
      audio.removeEventListener('seeked', update);
      audio.removeEventListener('timeupdate', update);
    };
  }, [audioRef, segments]);

  useEffect(() => {
    if (Date.now() < pausedScrollUntil.current) return;
    const el = items.current[active];
    if (!el) return;
    const reduce = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
  }, [active]);

  function seekTo(i: number) {
    const audio = audioRef.current;
    const seg = segments[i];
    if (!audio || !seg) return;
    pausedScrollUntil.current = 0; // chủ động chọn đoạn thì tự cuộn hoạt động lại
    audio.currentTime = segmentStartSeconds(seg);
    void audio.play().catch(() => undefined);
  }

  const holdAutoScroll = () => {
    pausedScrollUntil.current = Date.now() + USER_SCROLL_PAUSE_MS;
  };

  return (
    <div>
      <p className="mb-2 text-xs text-muted-foreground">{vi.voices.segmentsHint}</p>
      <div
        role="list"
        aria-label={vi.voices.synced}
        data-testid="synced-text"
        className="max-h-[28rem] space-y-1 overflow-y-auto rounded-lg border p-2"
        onWheel={holdAutoScroll}
        onTouchMove={holdAutoScroll}
      >
        {segments.map((s, i) => (
          <button
            key={s.idx}
            ref={(el) => {
              items.current[i] = el;
            }}
            type="button"
            role="listitem"
            data-idx={s.idx}
            data-active={i === active ? 'true' : 'false'}
            aria-current={i === active ? 'true' : undefined}
            onClick={() => seekTo(i)}
            className={cn(
              'block w-full rounded-md border-l-4 border-transparent px-3 py-2 text-left text-base leading-relaxed transition-colors hover:bg-accent/50',
              i === active && 'border-primary bg-primary/10 font-medium',
            )}
          >
            {s.text}
          </button>
        ))}
      </div>
    </div>
  );
}
