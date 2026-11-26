'use client';

import { useVirtualizer } from '@tanstack/react-virtual';
import { useCallback, useEffect, useRef } from 'react';
import { Play } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CueFields, CueTools, type CueActions } from '@/components/video/cue-editing';
import { useT } from '@/lib/i18n/client';
import { fmt } from '@/lib/i18n/fmt';
import { formatCueTime } from '@/lib/video/time';
import type { Cue } from '@/lib/video/types';
import { cn } from '@/lib/utils';

/** Sau khi người dùng tự cuộn hoặc chạm, tạm dừng tự cuộn trong khoảng này (như `player/synced-text.tsx`). */
const USER_SCROLL_PAUSE_MS = 3500;
/** Chiều cao ước tính của một hàng chưa đo. */
const ROW_PX = 128;

/**
 * Danh sách cue hai cột, chỉ dựng các hàng đang thấy (kịch bản tới 20.000 cue). Cue đang phát được tô sáng và cuộn vào giữa, trừ khi
 * người dùng đang tự cuộn hoặc đang gõ trong danh sách; bấm mốc của một cue để phát từ đó (spec 006, FR-022).
 */
export function CueList({
  cues,
  active,
  selectedId,
  readOnly,
  actions,
  reveal,
  onRevealed,
  onSelect,
  onSeek,
  onPlayFrom,
}: {
  cues: readonly Cue[];
  active: number;
  selectedId: string | null;
  readOnly: boolean;
  actions: CueActions;
  /** vừa thêm, tách hoặc xóa: cuộn tới cue này và đưa con trỏ vào câu dịch của nó, một lần */
  reveal: { id: string } | null;
  onRevealed: () => void;
  onSelect: (id: string) => void;
  /** bấm vào một cue: tua tới đầu cue */
  onSeek: (index: number) => void;
  onPlayFrom: (index: number) => void;
}) {
  const t = useT();
  const l = t.video.editor.list;
  const scroller = useRef<HTMLDivElement>(null);
  const pausedUntil = useRef(0);
  const pressing = useRef(false);
  const pressedAt = useRef(0);
  const getItemKey = useCallback((i: number) => cues[i]!.id, [cues]);
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({ count: cues.length, getScrollElement: () => scroller.current, estimateSize: () => ROW_PX, overscan: 6, getItemKey });
  const scrollToIndex = useRef(virtualizer.scrollToIndex);
  scrollToIndex.current = virtualizer.scrollToIndex;

  useEffect(() => {
    if (active < 0 || pressing.current || Date.now() < pausedUntil.current) return;
    // đang gõ hoặc đang dùng công cụ trong danh sách thì không kéo hàng đang sửa đi chỗ khác
    const focused = document.activeElement;
    if (focused && scroller.current?.contains(focused) && focused.matches('textarea, input, [data-testid="cue-tools"] button')) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    scrollToIndex.current(active, { align: 'center', behavior: reduce ? 'auto' : 'smooth' });
  }, [active]);

  const latest = useRef(cues);
  const done = useRef(onRevealed);
  useEffect(() => {
    latest.current = cues;
    done.current = onRevealed;
  }, [cues, onRevealed]);
  useEffect(() => {
    if (!reveal) return;
    const index = latest.current.findIndex((c) => c.id === reveal.id);
    if (index < 0) return;
    scrollToIndex.current(index, { align: 'center' });
    const asked = Date.now();
    // hàng được dựng sau khi khung cuộn đổi vị trí; trong lúc đó người dùng đã bấm chỗ khác thì không giành lại tiêu điểm
    const timer = setTimeout(() => {
      if (pressedAt.current <= asked) scroller.current?.querySelector<HTMLTextAreaElement>(`[data-index="${index}"] textarea[data-column="target"]`)?.focus({ preventScroll: true });
      // đã xử lý: gắn lại danh sách (đổi tab) không được cuộn và giành tiêu điểm lần nữa
      done.current();
    }, 80);
    return () => clearTimeout(timer);
  }, [reveal]);
  useEffect(() => {
    const release = () => {
      pressing.current = false;
    };
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);
    return () => {
      window.removeEventListener('pointerup', release);
      window.removeEventListener('pointercancel', release);
    };
  }, []);

  const holdAutoScroll = () => {
    pausedUntil.current = Date.now() + USER_SCROLL_PAUSE_MS;
  };

  return (
    <div className="space-y-2">
      <div className="hidden grid-cols-2 gap-2 px-4 text-xs font-medium text-muted-foreground sm:grid" aria-hidden>
        <span>{l.source}</span>
        <span>{l.target}</span>
      </div>
      <div
        ref={scroller}
        role="list"
        aria-label={l.label}
        data-testid="cue-list"
        className="max-h-[28rem] overflow-y-auto rounded-lg border p-2"
        onWheel={holdAutoScroll}
        onTouchMove={holdAutoScroll}
        onPointerDown={(e) => {
          // đang nhấn thì danh sách đứng yên để nút không trượt khỏi con trỏ; kéo thanh cuộn thì ngưng tự cuộn
          pressing.current = true;
          pressedAt.current = Date.now();
          if (e.target === e.currentTarget) holdAutoScroll();
        }}
      >
        <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((item) => {
            const cue = cues[item.index]!;
            const n = item.index + 1;
            const on = item.index === active;
            const selected = cue.id === selectedId;
            return (
              <div key={item.key} ref={virtualizer.measureElement} data-index={item.index} role="listitem" className="absolute top-0 left-0 w-full pb-1" style={{ transform: `translateY(${item.start}px)` }}>
                <div
                  data-testid="cue-row"
                  data-active={on ? 'true' : 'false'}
                  data-selected={selected ? 'true' : 'false'}
                  aria-current={on ? 'true' : undefined}
                  // chỉ ô nhập chọn hàng khi nhận tiêu điểm: chọn ngay lúc nhấn nút sẽ làm nút xê dịch trước khi nhả chuột
                  onFocusCapture={(e) => e.target.matches('textarea, input') && onSelect(cue.id)}
                  onClick={(e) => {
                    if ((e.target as HTMLElement).closest('textarea, input, button, label')) return onSelect(cue.id);
                    onSelect(cue.id);
                    onSeek(item.index);
                  }}
                  className={cn('space-y-2 rounded-md border-l-4 border-transparent px-3 py-2 transition-colors', selected && 'bg-accent/50', on && 'border-primary bg-primary/10')}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="tabular-nums text-muted-foreground"
                      aria-label={fmt(l.playFrom, { n })}
                      onClick={(e) => {
                        e.stopPropagation();
                        pausedUntil.current = 0; // chủ động chọn đoạn thì tự cuộn hoạt động lại
                        onPlayFrom(item.index);
                      }}
                    >
                      <Play className="size-3.5" />
                      {formatCueTime(cue.startMs)} – {formatCueTime(cue.endMs)}
                    </Button>
                    <span className="text-xs tabular-nums text-muted-foreground">#{n}</span>
                    {cue.flags.untranslated ? <Badge variant="secondary">{l.untranslated}</Badge> : null}
                    {cue.flags.fast ? <Badge variant="secondary">{l.fast}</Badge> : null}
                    {cue.timing === 'estimated' ? <Badge variant="outline">{l.estimated}</Badge> : null}
                  </div>
                  <CueFields cue={cue} number={n} readOnly={readOnly} actions={actions} />
                  {selected && !readOnly ? <CueTools cue={cue} number={n} isLast={item.index === cues.length - 1} actions={actions} /> : null}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
