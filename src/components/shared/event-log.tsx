'use client';

import { useFormat } from '@/lib/i18n/client';
import { cn } from '@/lib/utils';

export type EventLogEntry = { id: number; ts: string; level: 'info' | 'warn' | 'error'; text: string };

const LEVEL_STYLE: Record<EventLogEntry['level'], string> = {
  info: 'text-foreground',
  warn: 'text-amber-600 dark:text-amber-400',
  error: 'text-destructive',
};

/** Khung nhật ký của một tiến trình nền: giờ + nội dung đã dựng theo ngôn ngữ người xem. Dùng chung cho phiên âm và video overlay. */
export function EventLog({ entries, label, empty }: { entries: readonly EventLogEntry[]; label: string; empty: string }) {
  const fx = useFormat();
  return (
    <div role="log" aria-label={label} className="max-h-48 overflow-y-auto rounded-lg border bg-muted/30 p-3 font-mono text-xs leading-relaxed">
      {entries.length === 0 ? (
        <p className="text-muted-foreground">{empty}</p>
      ) : (
        entries.map((l) => (
          <div key={l.id} className={cn('flex gap-2 py-0.5', LEVEL_STYLE[l.level])}>
            <span className="shrink-0 text-muted-foreground">{fx.time(l.ts)}</span>
            <span className="min-w-0 break-words">{l.text}</span>
          </div>
        ))
      )}
    </div>
  );
}
