'use client';

import { Badge } from '@/components/ui/badge';
import { useT } from '@/lib/i18n/client';
import { cn } from '@/lib/utils';

export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'stopped' | 'interrupted';

const STYLE: Record<JobStatus, string> = {
  queued: 'bg-muted text-muted-foreground',
  running: 'bg-blue-500/15 text-blue-700 dark:text-blue-300',
  completed: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  failed: 'bg-destructive/15 text-destructive',
  stopped: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  interrupted: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
};

/** Huy hiệu trạng thái tiến trình (FR-020). */
export function StatusBadge({ status, className }: { status: JobStatus; className?: string }) {
  const t = useT();
  return (
    <Badge variant="outline" className={cn('border-transparent font-medium', STYLE[status], className)}>
      {status === 'running' ? <span className="mr-1.5 inline-block size-1.5 animate-pulse rounded-full bg-current" aria-hidden /> : null}
      {t.jobs.status[status]}
    </Badge>
  );
}
