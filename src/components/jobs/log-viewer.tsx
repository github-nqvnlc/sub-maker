'use client';

import { useEffect, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import type { ConnState, LogEntry } from '@/lib/hooks/use-job-stream';
import { useFormat, useT } from '@/lib/i18n/client';
import { renderJobLog } from '@/lib/i18n/job-log';
import type { Dict } from '@/lib/i18n/types';
import { cn } from '@/lib/utils';

const LEVEL_STYLE: Record<LogEntry['level'], string> = {
  info: 'text-foreground',
  warn: 'text-amber-600 dark:text-amber-400',
  error: 'text-destructive',
};

const connLabelOf = (t: Dict): Record<ConnState, string> => ({
  connecting: t.jobs.connecting,
  live: t.jobs.live,
  reconnecting: t.jobs.reconnecting,
  polling: t.jobs.polling,
  finished: t.jobs.finished,
});

/** Hiển thị log chi tiết: thời điểm, mức độ, nội dung; tự cuộn xuống cuối (tắt được) (FR-019). */
export function LogViewer({ logs, conn }: { logs: LogEntry[]; conn: ConnState }) {
  const t = useT();
  const fx = useFormat();
  const box = useRef<HTMLDivElement>(null);
  const [auto, setAuto] = useState(true);

  useEffect(() => {
    if (auto && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [logs.length, auto]);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-base font-semibold">{t.jobs.logs}</h2>
        <div className="flex items-center gap-3">
          <Badge variant="outline" className="gap-1.5" aria-live="polite">
            <span
              className={cn('inline-block size-2 rounded-full', conn === 'live' ? 'bg-emerald-500' : conn === 'finished' ? 'bg-muted-foreground' : 'animate-pulse bg-amber-500')}
              aria-hidden
            />
            {connLabelOf(t)[conn]}
          </Badge>
          <div className="flex items-center gap-2">
            <Switch id="auto-scroll" checked={auto} onCheckedChange={setAuto} />
            <Label htmlFor="auto-scroll" className="text-xs">
              {t.jobs.autoScroll}
            </Label>
          </div>
        </div>
      </div>
      <div
        ref={box}
        role="log"
        aria-label={t.jobs.logs}
        className="h-[calc(70dvh-5rem)] overflow-y-auto rounded-lg border bg-muted/30 p-3 font-mono text-xs leading-relaxed"
      >
        {logs.length === 0 ? (
          <p className="text-muted-foreground">{t.jobs.logsEmpty}</p>
        ) : (
          logs.map((l) => (
            <div key={l.id} className={cn('flex gap-2 py-0.5', LEVEL_STYLE[l.level])} data-code={l.code}>
              <span className="shrink-0 text-muted-foreground">{fx.time(l.ts)}</span>
              <span className="w-20 sm:w-25 shrink-0 uppercase opacity-70">{t.jobs.level[l.level]}</span>
              <span className="min-w-0 break-words">{renderJobLog(t, fx.locale, l)}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
