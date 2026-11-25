'use client';

import { useState } from 'react';
import { Download, RotateCcw, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Progress } from '@/components/ui/progress';
import { StatusBadge } from '@/components/jobs/status-badge';
import { JobConfig } from '@/components/overlay/job-config';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { DataTable, type Column } from '@/components/shared/data-table';
import { EventLog } from '@/components/shared/event-log';
import { EmptyState, ErrorState, LoadingList } from '@/components/shared/states';
import { fmtBytes, fmtDuration } from '@/lib/format';
import { OVERLAY_ACTIVE, useOverlayActions, useOverlayJob, useOverlayJobs, type OverlayJobDto, type OverlayLogDto } from '@/lib/hooks/use-overlay';
import { fmt } from '@/lib/i18n/fmt';
import { useFormat, useT } from '@/lib/i18n/client';
import type { Dict } from '@/lib/i18n/types';
import type { OverlayConfig } from '@/lib/overlay/config';

const errorOf = (t: Dict, code: string): string => (t.overlay.errors as Record<string, string>)[code] ?? t.overlay.errors.INTERNAL;

function logText(t: Dict, l: OverlayLogDto): string {
  const params = { ...(l.params ?? {}) };
  if (typeof params.reason === 'string') params.reason = errorOf(t, params.reason);
  return fmt((t.overlay.log as Record<string, string>)[l.messageKey] ?? l.messageKey, params);
}

function JobLog({ jobId }: { jobId: string }) {
  const t = useT();
  const q = useOverlayJob(jobId);
  if (q.isPending) return <LoadingList rows={2} />;
  if (q.isError) return <ErrorState message={t.overlay.logError} onRetry={() => void q.refetch()} />;
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <StatusBadge status={q.data.status} />
        <Progress value={q.data.progressPercent} className="h-1.5 flex-1" aria-label={t.overlay.progressLabel} />
        <span className="text-xs tabular-nums text-muted-foreground">{q.data.progressPercent}%</span>
      </div>
      <EventLog label={t.overlay.logLabel} empty={t.stt.logEmpty} entries={q.data.logs.map((l) => ({ id: l.id, ts: l.ts, level: l.level, text: logText(t, l) }))} />
    </div>
  );
}

/** Các lần xuất của Project: theo dõi, tải về, dừng, chạy lại, dùng lại cấu hình, xóa một hoặc nhiều (FR-036, FR-039, FR-042, FR-043). */
export function OverlayJobList({ projectId, onReuse }: { projectId: string; onReuse: (config: OverlayConfig) => void }) {
  const t = useT();
  const fx = useFormat();
  const jobs = useOverlayJobs(projectId);
  const { stop, rerun, remove } = useOverlayActions(projectId);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [logId, setLogId] = useState<string | null>(null);
  const [configJob, setConfigJob] = useState<OverlayJobDto | null>(null);
  const [confirmIds, setConfirmIds] = useState<string[] | null>(null);
  const onError = (e: unknown) => toast.error(e instanceof Error ? e.message : t.common.genericError);

  const rows = jobs.data ?? [];
  // lần xuất đã bị xóa ở nơi khác thì không còn nằm trong lựa chọn
  const selected = new Set(rows.filter((j) => picked.has(j.id)).map((j) => j.id));
  const total = rows.reduce((s, j) => s + (j.sizeBytes ?? 0), 0);
  const confirmRows = rows.filter((j) => confirmIds?.includes(j.id));

  const columns: Column<OverlayJobDto>[] = [
    { key: 'status', header: t.overlay.colStatus, cell: (j) => <StatusBadge status={j.status} /> },
    {
      key: 'video',
      header: t.overlay.colVideo,
      cell: (j) => (
        <div className="max-w-64 min-w-40 space-y-0.5 whitespace-normal">
          <p className="line-clamp-1 break-all font-medium" title={j.sourceNames.subtitle}>
            {j.sourceNames.subtitle}
          </p>
          <p className="text-xs text-muted-foreground">
            .{j.format} · {j.width}×{j.height} · {fmtDuration(j.durationMs)} · {j.sizeBytes === null ? `~${fmtBytes(j.estimatedBytes)}` : fmtBytes(j.sizeBytes)}
          </p>
          {j.errorCode ? (
            <p role="alert" className="text-xs text-destructive">
              {errorOf(t, j.errorCode)}
            </p>
          ) : null}
          {(j.status === 'failed' || j.status === 'stopped') && !j.canRerun ? <p className="text-xs text-muted-foreground">{t.overlay.rerunUnavailable}</p> : null}
        </div>
      ),
    },
    {
      key: 'progress',
      header: t.overlay.colProgress,
      cell: (j) => (
        <div className="flex min-w-28 items-center gap-2">
          <Progress value={j.progressPercent} className="h-1.5 w-20" aria-label={t.overlay.progressLabel} />
          <span className="text-xs tabular-nums text-muted-foreground">{j.progressPercent}%</span>
        </div>
      ),
    },
    { key: 'created', header: t.overlay.colCreated, cell: (j) => <span className="whitespace-nowrap text-xs">{fx.dateTime(j.createdAt)}</span>, className: 'hidden md:table-cell' },
    {
      key: 'actions',
      header: t.overlay.colActions,
      cell: (j) => (
        <div className="flex flex-wrap gap-1">
          {j.status === 'completed' ? (
            <Button asChild size="sm" variant="outline">
              <a href={`/api/overlay/jobs/${j.id}/video`} download>
                <Download className="size-3.5" />
                {t.overlay.download}
              </a>
            </Button>
          ) : null}
          {OVERLAY_ACTIVE.has(j.status) ? (
            <Button size="sm" variant="outline" disabled={stop.isPending} onClick={() => stop.mutate(j.id, { onSuccess: () => toast.success(t.jobs.stopRequested), onError })}>
              {t.overlay.stop}
            </Button>
          ) : null}
          {j.canRerun ? (
            <Button size="sm" variant="outline" disabled={rerun.isPending} onClick={() => rerun.mutate(j.id, { onSuccess: () => toast.success(t.overlay.rerunStarted), onError })}>
              <RotateCcw className="size-3.5" />
              {t.overlay.rerun}
            </Button>
          ) : null}
          <Button size="sm" variant="outline" onClick={() => setLogId(j.id)}>
            {t.overlay.showLog}
          </Button>
          <Button size="sm" variant="outline" onClick={() => setConfigJob(j)}>
            {t.overlay.showConfig}
          </Button>
          <Button size="sm" variant="outline" onClick={() => onReuse(j.config)}>
            {t.overlay.reuse}
          </Button>
          <Button size="icon" variant="ghost" aria-label={t.overlay.delete} onClick={() => setConfirmIds([j.id])}>
            <Trash2 className="size-4" />
          </Button>
        </div>
      ),
    },
  ];

  return (
    <section className="space-y-3" aria-labelledby="overlay-list-title">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="overlay-list-title" className="text-base font-semibold">
          {t.overlay.listTitle}
        </h2>
        <Badge variant="secondary">{rows.length}</Badge>
        {total > 0 ? <p className="text-xs text-muted-foreground">{fmt(t.overlay.totalSize, { size: fmtBytes(total) })}</p> : null}
      </div>

      {selected.size > 0 ? (
        <div className="flex items-center justify-between rounded-lg border bg-accent/40 px-3 py-2" role="status">
          <span className="text-sm">
            {selected.size} {t.projects.selectedCount}
          </span>
          <Button size="sm" variant="destructive" onClick={() => setConfirmIds([...selected])}>
            <Trash2 className="size-4" />
            {t.jobs.deleteSelected}
          </Button>
        </div>
      ) : null}

      {jobs.isPending ? (
        <LoadingList rows={2} />
      ) : jobs.isError ? (
        <ErrorState message={t.overlay.listError} onRetry={() => void jobs.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState title={t.overlay.listEmpty} />
      ) : (
        <DataTable
          rows={rows}
          columns={columns}
          rowId={(j) => j.id}
          selected={selected}
          onSelectedChange={setPicked}
          selectAllLabel={t.overlay.selectAll}
          selectLabel={t.overlay.selectRow}
        />
      )}

      <Dialog open={!!logId} onOpenChange={(o) => !o && setLogId(null)}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t.overlay.logLabel}</DialogTitle>
            <DialogDescription className="break-all">{rows.find((j) => j.id === logId)?.sourceNames.subtitle}</DialogDescription>
          </DialogHeader>
          {logId ? <JobLog jobId={logId} /> : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setLogId(null)}>
              {t.overlay.close}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!configJob} onOpenChange={(o) => !o && setConfigJob(null)}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t.overlay.configTitle}</DialogTitle>
            <DialogDescription className="break-all">{configJob?.sourceNames.subtitle}</DialogDescription>
          </DialogHeader>
          {configJob ? <JobConfig job={configJob} /> : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfigJob(null)}>
              {t.overlay.close}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!confirmIds}
        onOpenChange={(o) => !o && setConfirmIds(null)}
        title={confirmRows.length > 1 ? t.overlay.deleteManyTitle : t.overlay.deleteTitle}
        description={
          <>
            <p className="font-medium text-foreground">{fmt(t.overlay.deleteCount, { n: confirmRows.length, size: fmtBytes(confirmRows.reduce((s, j) => s + (j.sizeBytes ?? 0), 0)) })}</p>
            <p>{t.overlay.deleteDesc}</p>
            {confirmRows.some((j) => OVERLAY_ACTIVE.has(j.status)) ? <p>{t.overlay.deleteActiveDesc}</p> : null}
          </>
        }
        confirmLabel={t.overlay.delete}
        onConfirm={async () => {
          if (!confirmIds) return;
          try {
            const r = await remove.mutateAsync(confirmIds);
            if (r.deleted.length > 0) toast.success(t.overlay.deleted);
            if (r.busy.length > 0) toast.error(t.overlay.deleteBusy);
            setPicked(new Set());
          } catch (e) {
            onError(e);
          }
        }}
      />
    </section>
  );
}
