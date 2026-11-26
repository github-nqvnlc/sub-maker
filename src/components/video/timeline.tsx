'use client';

import { useState } from 'react';
import { Slider } from '@/components/ui/slider';
import { useMediaTime } from '@/lib/hooks/use-media-clock';
import { useT } from '@/lib/i18n/client';
import { fmt } from '@/lib/i18n/fmt';
import type { Edge } from '@/lib/video/cue-ops';
import { formatCueTime } from '@/lib/video/time';
import type { Cue } from '@/lib/video/types';
import { cn } from '@/lib/utils';

/** Khoảng nhìn hai bên cue đang chọn. */
const MARGIN_MS = 3000;
const MIN_SPAN_MS = 8000;

type View = { id: string; from: number; to: number };

function viewOf(cue: Cue, durationMs: number): View {
  const span = Math.max(MIN_SPAN_MS, cue.endMs - cue.startMs + MARGIN_MS * 2);
  const from = Math.max(0, cue.startMs - Math.round((span - (cue.endMs - cue.startMs)) / 2));
  return { id: cue.id, from, to: Math.min(durationMs, Math.max(from + span, cue.endMs)) };
}

/**
 * Dòng thời gian quanh cue đang chọn (spec 006, FR-023): kéo mốc bắt đầu, kết thúc; phím mũi tên dịch 100 ms, giữ Shift dịch 500 ms.
 * Khoảng nhìn đứng yên trong lúc chỉnh để mốc không trượt dưới con trỏ. Việc kẹp theo cue liền kề do nơi nhận quyết định.
 */
export function Timeline({
  cues,
  selectedId,
  durationMs,
  mediaRef,
  disabled,
  onChange,
}: {
  cues: readonly Cue[];
  selectedId: string | null;
  durationMs: number;
  mediaRef: React.RefObject<HTMLVideoElement | null>;
  disabled: boolean;
  onChange: (id: string, edge: Edge, ms: number) => void;
}) {
  const t = useT();
  const l = t.video.editor.timeline;
  const now = useMediaTime(mediaRef);
  const index = cues.findIndex((c) => c.id === selectedId);
  const cue = cues[index];
  const [view, setView] = useState<View | null>(null);
  // dựng lại khoảng nhìn khi đổi cue hoặc mốc đã ra ngoài
  if (cue && (view?.id !== cue.id || cue.startMs < view.from || cue.endMs > view.to)) setView(viewOf(cue, durationMs));

  if (!cue || !view) {
    return <p className="rounded-lg border border-dashed p-4 text-xs text-muted-foreground">{l.none}</p>;
  }
  const span = Math.max(1, view.to - view.from);
  const at = (ms: number) => `${(Math.min(span, Math.max(0, ms - view.from)) / span) * 100}%`;
  const near = cues.filter((c) => c.endMs > view.from && c.startMs < view.to);

  const edges: Array<{ edge: Edge; value: number; label: string }> = [
    { edge: 'start', value: cue.startMs, label: l.start },
    { edge: 'end', value: cue.endMs, label: l.end },
  ];

  return (
    <section className="space-y-2 rounded-lg border p-4" aria-labelledby="video-timeline-title" data-testid="video-timeline">
      <h2 id="video-timeline-title" className="text-base font-semibold">
        {l.title}
      </h2>
      <div className="relative h-8 overflow-hidden rounded-md border bg-muted/30" aria-hidden>
        {near.map((c) => (
          <div
            key={c.id}
            className={cn('absolute inset-y-1 rounded-sm', c.id === cue.id ? 'bg-primary/40' : 'bg-muted-foreground/25')}
            style={{ left: at(c.startMs), width: `calc(${at(c.endMs)} - ${at(c.startMs)})` }}
          />
        ))}
        {now >= view.from && now <= view.to ? <div className="absolute inset-y-0 w-0.5 bg-foreground" style={{ left: at(now) }} /> : null}
      </div>
      <div className="flex justify-between text-xs tabular-nums text-muted-foreground">
        <span>{formatCueTime(view.from)}</span>
        <span>{formatCueTime(view.to)}</span>
      </div>
      {edges.map(({ edge, value, label }) => (
        <div
          key={edge}
          className="flex items-center gap-3"
          onKeyDownCapture={(e) => {
            const sign = e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : 0;
            if (sign === 0 || disabled) return;
            e.preventDefault();
            e.stopPropagation();
            onChange(cue.id, edge, value + sign * (e.shiftKey ? 500 : 100));
          }}
        >
          <Slider
            className="flex-1"
            min={view.from}
            max={view.to}
            step={10}
            value={[value]}
            disabled={disabled}
            onValueChange={([v]) => v !== undefined && onChange(cue.id, edge, v)}
            // thả tay: dựng lại khoảng nhìn để kéo tiếp được xa hơn
            onValueCommit={() => setView(null)}
            aria-label={label}
          />
          <span className="w-20 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{formatCueTime(value)}</span>
        </div>
      ))}
      <p className="text-xs text-muted-foreground">{fmt(l.hint, { n: index + 1 })}</p>
    </section>
  );
}
