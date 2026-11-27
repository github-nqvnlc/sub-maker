'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Download, RotateCcw, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { StatusBadge, type JobStatus } from '@/components/jobs/status-badge';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { DataTable, type Column } from '@/components/shared/data-table';
import { EmptyState } from '@/components/shared/states';
import { apiDelete, apiPost } from '@/lib/api-client';
import { fmtBytes, fmtDuration } from '@/lib/format';
import { videoKeys, type VideoJobDetailDto } from '@/lib/hooks/use-video';
import { useFormat, useT } from '@/lib/i18n/client';
import { fmt } from '@/lib/i18n/fmt';
import type { VideoExportDto } from '@/lib/video/service';
import { videoErrorText } from '@/lib/video/text';

const TONE: Record<VideoExportDto['status'], JobStatus> = {
  queued: 'queued',
  running: 'running',
  completed: 'completed',
  failed: 'failed',
  stopped: 'stopped',
  interrupted: 'interrupted',
  expired: 'stopped',
};
const isActive = (e: VideoExportDto) => e.status === 'queued' || e.status === 'running' || e.status === 'interrupted';

/** Giờ hiện tại, cập nhật mỗi phút: thành phẩm quá hạn thì thôi mời tải (luồng sự kiện đã đóng). */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** Các bản xuất của một việc: tiến độ, tải về, dừng, chạy lại, xóa, ngày hết hạn (spec 006, US3; FR-045, FR-049, FR-054). */
export function ExportList({ job, revision }: { job: VideoJobDetailDto; revision: number }) {
  const t = useT();
  const fx = useFormat();
  const l = t.video.exports;
  const qc = useQueryClient();
  const [target, setTarget] = useState<VideoExportDto | null>(null);
  const [open, setOpen] = useState(false);
  const now = useNow();
  const total = job.exports.reduce((n, e) => n + (e.status === 'completed' ? (e.sizeBytes ?? 0) : 0), 0);
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: videoKeys.job(job.id) });
    await qc.invalidateQueries({ queryKey: videoKeys.jobs(job.projectId) });
    await qc.invalidateQueries({ queryKey: videoKeys.tab(job.projectId) });
  };
  const onError = (e: unknown) => toast.error(e instanceof Error ? e.message : t.common.genericError);
  const stop = useMutation({ mutationFn: (id: string) => apiPost(`/api/video/exports/${id}/stop`), onSettled: refresh });
  const rerun = useMutation({ mutationFn: (id: string) => apiPost(`/api/video/exports/${id}/rerun`), onSettled: refresh });
  const remove = useMutation({ mutationFn: (id: string) => apiDelete(`/api/video/exports/${id}`), onSettled: refresh });
  /** bản đang chạy lấy tiến độ của việc (cập nhật theo luồng sự kiện) */
  const percentOf = (e: VideoExportDto) => (e.status === 'completed' || e.status === 'expired' ? 100 : isActive(e) ? Math.max(e.progressPercent, job.progressPercent) : e.progressPercent);

  const columns: Column<VideoExportDto>[] = [
    { key: 'status', header: l.colStatus, cell: (e) => <StatusBadge status={TONE[e.status]} label={l.status[e.status]} /> },
    {
      key: 'video',
      header: l.colVideo,
      cell: (e) => (
        <div className="max-w-64 min-w-40 space-y-0.5 whitespace-normal">
          <p className="font-medium">{fmt(l.createdAt, { date: fx.dateTime(e.createdAt) })}</p>
          <p className="text-xs text-muted-foreground">
            {l.kinds[e.kind === 'layer' ? 'layer' : 'burn']} · .{e.format} · {fmtDuration(e.durationMs)} ·{' '}
            {e.sizeBytes === null ? fmt(l.estimated, { size: fmtBytes(e.estimatedBytes) }) : fmtBytes(e.sizeBytes)}
          </p>
          {e.cueRevision < revision ? <p className="text-xs text-muted-foreground">{l.outdated}</p> : null}
          {e.expiresAt ? (
            <p className="text-xs text-muted-foreground md:hidden">
              {l.colExpires}: {fx.dateTime(e.expiresAt)}
            </p>
          ) : null}
          {(e.status === 'failed' || e.status === 'stopped') && (job.sourceState === 'deleted' || job.sourceState === 'rejected') ? <p className="text-xs text-muted-foreground">{l.rerunUnavailable}</p> : null}
          {e.errorCode ? (
            <p role="alert" className="text-xs text-destructive">
              {videoErrorText(t, e.errorCode)}
            </p>
          ) : null}
        </div>
      ),
    },
    {
      key: 'progress',
      header: l.colProgress,
      cell: (e) => (
        <div className="flex min-w-28 items-center gap-2">
          <Progress value={percentOf(e)} className="h-1.5 w-20" aria-label={l.progressLabel} />
          <span className="text-xs tabular-nums text-muted-foreground">{percentOf(e)}%</span>
        </div>
      ),
    },
    { key: 'expires', header: l.colExpires, className: 'hidden md:table-cell', cell: (e) => <span className="whitespace-nowrap text-xs">{e.expiresAt ? fx.dateTime(e.expiresAt) : '—'}</span> },
    {
      key: 'actions',
      header: l.colActions,
      cell: (e) => (
        <div className="flex flex-wrap gap-1">
          {e.status === 'completed' && (!e.expiresAt || Date.parse(e.expiresAt) > now) ? (
            <Button asChild size="sm" variant="outline">
              <a href={`/api/video/exports/${e.id}/video`} download>
                <Download className="size-3.5" />
                {l.download}
              </a>
            </Button>
          ) : null}
          {isActive(e) ? (
            <Button size="sm" variant="outline" disabled={stop.isPending} onClick={() => stop.mutate(e.id, { onSuccess: () => toast.success(l.stopRequested), onError })}>
              {l.stop}
            </Button>
          ) : null}
          {(e.status === 'failed' || e.status === 'stopped') && job.sourceState === 'ready' ? (
            <Button size="sm" variant="outline" disabled={rerun.isPending} onClick={() => rerun.mutate(e.id, { onSuccess: () => toast.success(l.rerunStarted), onError })}>
              <RotateCcw className="size-3.5" />
              {l.rerun}
            </Button>
          ) : null}
          <Button
            size="icon"
            variant="ghost"
            aria-label={fmt(l.delete, { date: fx.dateTime(e.createdAt) })}
            onClick={() => {
              setTarget(e);
              setOpen(true);
            }}
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
      ),
    },
  ];

  return (
    <section className="space-y-3" aria-labelledby="video-exports-title">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="video-exports-title" className="text-base font-semibold">
          {l.title}
        </h2>
        <Badge variant="secondary">{job.exports.length}</Badge>
        {total > 0 ? <p className="text-xs text-muted-foreground">{fmt(l.totalSize, { size: fmtBytes(total) })}</p> : null}
      </div>
      {job.exports.length === 0 ? <EmptyState title={l.empty} /> : <DataTable rows={job.exports} columns={columns} rowId={(e) => e.id} />}
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={l.deleteTitle}
        description={
          <>
            {/* chỉ thành phẩm còn giữ mới trả lại hạn mức; bản lỗi, đã dừng, hết hạn không còn tệp */}
            <p className="font-medium text-foreground">
              {target?.status === 'completed' ? fmt(l.deleteCount, { n: 1, size: fmtBytes(target.sizeBytes ?? 0) }) : fmt(l.deleteCountOnly, { n: 1 })}
            </p>
            <p>{target ? fmt(l.createdAt, { date: fx.dateTime(target.createdAt) }) : null}</p>
            <p>{target?.status === 'completed' ? l.deleteDesc : l.deleteDescNoFile}</p>
            {target && isActive(target) ? <p>{l.deleteActiveDesc}</p> : null}
          </>
        }
        confirmLabel={t.common.delete}
        onConfirm={async () => {
          if (!target) return;
          try {
            await remove.mutateAsync(target.id);
            toast.success(l.deleted);
          } catch (e) {
            onError(e);
          }
        }}
      />
    </section>
  );
}
