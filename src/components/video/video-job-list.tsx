'use client';

import Link from 'next/link';
import { useState } from 'react';
import { RotateCcw, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Progress } from '@/components/ui/progress';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { DataTable, type Column } from '@/components/shared/data-table';
import { EventLog } from '@/components/shared/event-log';
import { EmptyState, ErrorState, LoadingList } from '@/components/shared/states';
import { VideoStatusBadge } from '@/components/video/status';
import { fmtBytes, fmtDuration } from '@/lib/format';
import { useUploadVersion, useVideoActions, useVideoEvents, useVideoJob, useVideoJobs, type VideoJobDto } from '@/lib/hooks/use-video';
import { useFormat, useT } from '@/lib/i18n/client';
import { fmt } from '@/lib/i18n/fmt';
import { videoErrorText, videoLogText } from '@/lib/video/text';
import { uploadRegistry } from '@/lib/video/upload-client';

/** Phần trăm hiển thị: đang tải lên thì theo dữ liệu đã gửi, còn lại theo tiến trình ở máy chủ (FR-049). */
function percentOf(j: VideoJobDto): number {
  if (j.displayStatus !== 'waiting_media') return j.progressPercent;
  const live = uploadRegistry.get(j.id)?.getSnapshot();
  if (live) return live.percent;
  return j.upload ? Math.floor((j.upload.receivedBytes / Math.max(1, j.upload.sizeBytes)) * 100) : 0;
}

/** Dung lượng được trả lại khi xóa: video đang giữ và chỗ giữ trước của phiên tải đang mở. */
const freedBytes = (j: VideoJobDto): number => j.storedBytes + (j.upload?.sizeBytes ?? 0);

/** `row`: bản ghi trong danh sách (hỏi lại định kỳ, có tiến độ tải lên) — dùng cho phần trạng thái khi có. */
function JobLog({ jobId, row }: { jobId: string; row?: VideoJobDto }) {
  const t = useT();
  const q = useVideoJob(jobId);
  useVideoEvents(jobId);
  if (q.isPending) return <LoadingList rows={2} />;
  if (q.isError && !q.data) return <ErrorState message={t.video.list.logError} onRetry={() => void q.refetch()} />;
  const job = row?.upload ? row : q.data!;
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <VideoStatusBadge status={job.displayStatus} />
        <Progress value={percentOf(job)} className="h-1.5 flex-1" aria-label={t.video.list.progressLabel} />
        <span className="text-xs tabular-nums text-muted-foreground">{percentOf(job)}%</span>
      </div>
      <EventLog label={t.video.list.logLabel} empty={t.video.list.logEmpty} entries={q.data!.logs.map((l) => ({ id: l.id, ts: l.ts, level: l.level, text: videoLogText(t, l) }))} />
    </div>
  );
}

/** Các việc dịch video của Project: theo dõi tiến độ, xem nhật ký, dừng, chạy lại, xóa (spec 006, FR-044, FR-045, FR-054). */
export function VideoJobList({ projectId, allowed }: { projectId: string; allowed: boolean }) {
  const t = useT();
  const fx = useFormat();
  const jobs = useVideoJobs(projectId);
  useUploadVersion(); // vẽ lại khi tiến độ tải lên đổi
  const { stop, rerun, remove } = useVideoActions(projectId);
  const [logId, setLogId] = useState<string | null>(null);
  const [stopTarget, setStopTarget] = useState<VideoJobDto | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<VideoJobDto | null>(null);
  const onError = (e: unknown) => toast.error(e instanceof Error ? e.message : t.common.genericError);
  const l = t.video.list;
  const rows = jobs.data ?? [];
  const requestStop = async (id: string) => {
    try {
      await stop.mutateAsync(id);
      toast.success(l.stopRequested);
    } catch (e) {
      onError(e);
    }
  };
  const expiryOf = (j: VideoJobDto): string => (j.sourceState === 'deleted' ? l.sourceDeleted : j.sourceExpiresAt ? fx.dateTime(j.sourceExpiresAt) : '—');
  /** việc đã dừng hoặc lỗi mà không chạy lại được: nói lý do */
  const rerunBlocker = (j: VideoJobDto): string | null =>
    j.displayStatus !== 'failed' && j.displayStatus !== 'stopped' ? null : j.cueCount > 0 ? null : !j.canRerun ? l.cannotRerun : !allowed ? l.rerunNeedsPermission : null;

  const columns: Column<VideoJobDto>[] = [
    {
      key: 'file',
      header: l.colFile,
      cell: (j) => (
        <div className="max-w-md min-w-44 space-y-0.5 whitespace-normal">
          <p className="line-clamp-2 break-all font-medium" title={j.fileName}>
            {j.fileName}
          </p>
          <p className="text-xs text-muted-foreground">
            {fmtBytes(j.size)}
            {j.durationMs !== null ? ` · ${fmtDuration(j.durationMs)}` : null} · {t.video.upload.directions[j.direction]}
          </p>
          {j.cueCount > 0 ? <p className="text-xs text-muted-foreground">{fmt(l.cueCount, { n: j.cueCount })}</p> : null}
          {/* màn hình hẹp ẩn cột ngày xóa */}
          <p className="text-xs text-muted-foreground md:hidden">
            {l.colExpires}: {expiryOf(j)}
          </p>
          {j.errorCode ? (
            <p role="alert" className="text-xs text-destructive">
              {videoErrorText(t, j.errorCode)}
            </p>
          ) : null}
          {rerunBlocker(j) ? <p className="text-xs text-muted-foreground">{rerunBlocker(j)}</p> : null}
        </div>
      ),
    },
    { key: 'status', header: l.colStatus, cell: (j) => <VideoStatusBadge status={j.displayStatus} /> },
    {
      key: 'progress',
      header: l.colProgress,
      cell: (j) => (
        <div className="flex min-w-28 items-center gap-2">
          <Progress value={percentOf(j)} className="h-1.5 w-20" aria-label={l.progressLabel} />
          <span className="text-xs tabular-nums text-muted-foreground">{percentOf(j)}%</span>
        </div>
      ),
    },
    {
      key: 'expires',
      header: l.colExpires,
      className: 'hidden md:table-cell',
      cell: (j) => <span className="whitespace-nowrap text-xs">{expiryOf(j)}</span>,
    },
    {
      key: 'actions',
      header: l.colActions,
      cell: (j) => (
        <div className="flex flex-wrap gap-1">
          {j.cueCount > 0 || j.editable ? (
            <Button asChild size="sm" variant="outline">
              <Link href={`/projects/${projectId}/video/${j.id}`}>{l.open}</Link>
            </Button>
          ) : null}
          {j.canStop ? (
            // đang dịch (hoặc bị gián đoạn khi đang dịch) mà dừng có thể mất kết quả đã trả phí: hỏi trước
            <Button size="sm" variant="outline" disabled={stop.isPending} onClick={() => (j.displayStatus === 'translating' || j.displayStatus === 'interrupted' ? setStopTarget(j) : void requestStop(j.id))}>
              {l.stop}
            </Button>
          ) : null}
          {j.canRerun && allowed ? (
            <Button size="sm" variant="outline" disabled={rerun.isPending} onClick={() => rerun.mutate(j.id, { onSuccess: () => toast.success(l.rerunStarted), onError })}>
              <RotateCcw className="size-3.5" />
              {l.rerun}
            </Button>
          ) : null}
          <Button size="sm" variant="outline" onClick={() => setLogId(j.id)}>
            {l.log}
          </Button>
          <Button size="icon" variant="ghost" aria-label={`${l.delete}: ${j.fileName}`} onClick={() => setDeleteTarget(j)}>
            <Trash2 className="size-4" />
          </Button>
        </div>
      ),
    },
  ];

  return (
    <section className="space-y-3" aria-labelledby="video-list-title">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="video-list-title" className="text-base font-semibold">
          {l.title}
        </h2>
        <Badge variant="secondary">{rows.length}</Badge>
      </div>

      {jobs.isPending ? (
        <LoadingList rows={2} />
      ) : jobs.isError && !jobs.data ? (
        <ErrorState message={l.error} onRetry={() => void jobs.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState title={l.empty} />
      ) : (
        <DataTable rows={rows} columns={columns} rowId={(j) => j.id} />
      )}

      <Dialog open={!!logId} onOpenChange={(o) => !o && setLogId(null)}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{l.logLabel}</DialogTitle>
            <DialogDescription className="break-all">{rows.find((j) => j.id === logId)?.fileName}</DialogDescription>
          </DialogHeader>
          {logId ? <JobLog jobId={logId} row={rows.find((j) => j.id === logId)} /> : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setLogId(null)}>
              {l.close}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!stopTarget}
        onOpenChange={(o) => !o && setStopTarget(null)}
        title={l.stopTitle}
        description={
          <>
            <p className="font-medium text-foreground">{l.stopCount}</p>
            <p className="break-all">{stopTarget?.fileName}</p>
            <p>{l.stopDesc}</p>
          </>
        }
        confirmLabel={l.stop}
        onConfirm={async () => {
          if (stopTarget) await requestStop(stopTarget.id);
        }}
      />

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
        title={l.deleteTitle}
        description={
          <>
            <p className="font-medium text-foreground">{fmt(l.deleteCount, { n: 1, size: fmtBytes(deleteTarget ? freedBytes(deleteTarget) : 0) })}</p>
            <p className="break-all">{deleteTarget?.fileName}</p>
            <p>{l.deleteDesc}</p>
            {deleteTarget?.canStop || deleteTarget?.upload ? <p>{l.deleteActiveDesc}</p> : null}
          </>
        }
        confirmLabel={l.delete}
        onConfirm={async () => {
          if (!deleteTarget) return;
          try {
            await remove.mutateAsync(deleteTarget.id);
            toast.success(l.deleted);
          } catch (e) {
            onError(e);
          }
        }}
      />
    </section>
  );
}
