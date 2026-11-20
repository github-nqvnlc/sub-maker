'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Headphones, Pause, Play, RotateCcw, SlidersHorizontal, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { ErrorState, LoadingList } from '@/components/shared/states';
import { EditSettingsDialog } from '@/components/jobs/edit-settings-dialog';
import { LogViewer } from '@/components/jobs/log-viewer';
import { StatusBadge, type JobStatus } from '@/components/jobs/status-badge';
import { api, apiPost } from '@/lib/api-client';
import { fmt } from '@/lib/i18n/fmt';
import { translateMessage } from '@/lib/i18n/server-messages';
import { useJobStream } from '@/lib/hooks/use-job-stream';
import { useFormat, useT } from '@/lib/i18n/client';
import { cn } from '@/lib/utils';

const ACTIVE: JobStatus[] = ['queued', 'running'];
const RESUMABLE: JobStatus[] = ['stopped', 'failed', 'interrupted'];

type JobDetail = {
  id: string;
  projectId: string;
  fileId: string;
  providerType: string;
  status: JobStatus;
  configScope: 'global' | 'user';
  settings: { model: string | null; voice: string; speed: number | null; timing?: { mode: 'timed'; mergeCues: boolean } | null };
  progressDone: number;
  progressTotal: number;
  errorCode: string | null;
  errorMessage: string | null;
  voiceId: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  failedSegments: { idx: number; errorCode: string }[];
  timing?: { mode: 'timed'; mergeCues: boolean; overflowCount: number; parts?: { done: number; total: number } } | null;
};

/** Màn hình theo dõi một tiến trình: trạng thái, tiến độ, log thời gian thực, đoạn lỗi (FR-019, FR-020). */
export function JobMonitor({ jobId }: { jobId: string }) {
  const t = useT();
  const fx = useFormat();
  const router = useRouter();
  const qc = useQueryClient();
  const stream = useJobStream(jobId);
  const finished = stream.status === 'completed' || stream.status === 'failed' || stream.status === 'stopped';

  const [editMode, setEditMode] = useState<'edit' | 'rerun' | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const detail = useQuery({
    // Tải lại chi tiết khi trạng thái đổi để có đoạn lỗi/voiceId mới nhất
    queryKey: ['job', jobId, stream.status],
    queryFn: () => api<JobDetail>(`/api/jobs/${jobId}`),
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['job', jobId] });
    void qc.invalidateQueries({ queryKey: ['project'] });
    void qc.invalidateQueries({ queryKey: ['active-jobs'] });
  };

  const stop = useMutation({
    mutationFn: () => apiPost(`/api/jobs/${jobId}/stop`, {}),
    onSuccess: () => {
      toast.success(t.jobs.stopRequested);
      refresh();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : t.common.genericError),
  });

  const resume = useMutation({
    mutationFn: () => apiPost(`/api/jobs/${jobId}/resume`, {}),
    onSuccess: () => {
      toast.success(t.jobs.resumed);
      refresh();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : t.common.genericError),
  });

  const del = useMutation({
    mutationFn: () =>
      apiPost<{ deleted: string[]; rejectedRunning: string[] }>('/api/jobs/bulk-delete', {
        ids: [jobId],
        stopFirst: true,
      }),
    onSuccess: (r) => {
      if (r.deleted.length > 0) {
        toast.success(t.jobs.deleted);
        void qc.invalidateQueries({ queryKey: ['project', job?.projectId] });
        void qc.invalidateQueries({ queryKey: ['projects'] });
        void qc.invalidateQueries({ queryKey: ['active-jobs'] });
        if (job) router.push(`/projects/${job.projectId}`);
      } else if (r.rejectedRunning.length > 0) {
        toast.error(t.jobs.busyNotice);
      }
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : t.common.genericError),
  });

  if (detail.isPending) return <LoadingList rows={3} />;
  if (detail.isError) return <ErrorState message={detail.error.message} onRetry={() => void detail.refetch()} />;
  const job = detail.data;
  const status = stream.status ?? job.status;
  const done = stream.total > 0 ? stream.done : job.progressDone;
  const total = stream.total > 0 ? stream.total : job.progressTotal;
  const percent = total > 0 ? Math.round((done / total) * 100) : 0;
  const voiceId = stream.voiceId ?? job.voiceId;
  const storedError = stream.errorMessage ?? job.errorMessage;
  const errorMessage = storedError ? translateMessage(fx.locale, storedError) : storedError;

  const canStop = ACTIVE.includes(status);
  const canResume = RESUMABLE.includes(status);
  const canEdit = RESUMABLE.includes(status);
  const canRerun = !ACTIVE.includes(status);
  const canListen = Boolean(voiceId);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-2">
            <CardTitle className="flex flex-wrap items-center gap-2 text-lg">
              <StatusBadge status={status} />
              <Badge variant="secondary">{job.configScope === 'user' ? t.jobs.scopeUser : t.jobs.scopeGlobal}</Badge>
              {job.timing ? <Badge variant="outline">{t.jobs.modeBadge}</Badge> : null}
            </CardTitle>
            <div>
              <Button asChild variant="outline" size="sm">
                <Link href={`/projects/${job.projectId}`}>
                  <ArrowLeft className="size-3.5" />
                  <span>{t.jobs.backToProject}</span>
                </Link>
              </Button>
            </div>
          </div>

          <CardAction className="flex flex-wrap items-center gap-1.5 self-center">
            <TooltipProvider delayDuration={150}>
              {/* Dừng */}
              <Tooltip>
                <TooltipTrigger asChild>
                  <span>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!canStop || stop.isPending}
                      onClick={() => stop.mutate()}
                      className={cn(canStop && 'border-amber-500/50 text-amber-500 hover:bg-amber-500/10 hover:text-amber-600')}
                    >
                      <Pause className="size-3.5" />
                      <span>{t.jobs.stop}</span>
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent>{canStop ? t.jobs.stop : t.jobs.status.stopped}</TooltipContent>
              </Tooltip>

              {/* Tiếp tục */}
              <Tooltip>
                <TooltipTrigger asChild>
                  <span>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!canResume || resume.isPending}
                      onClick={() => resume.mutate()}
                      className={cn(canResume && 'border-primary/50 text-primary hover:bg-primary/10')}
                    >
                      <Play className="size-3.5 fill-current" />
                      <span>{t.jobs.resume}</span>
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent>{canResume ? t.jobs.resume : t.jobs.resumeDisabledTip}</TooltipContent>
              </Tooltip>

              {/* Sửa thiết lập */}
              <Tooltip>
                <TooltipTrigger asChild>
                  <span>
                    <Button size="sm" variant="outline" disabled={!canEdit} onClick={() => setEditMode('edit')}>
                      <SlidersHorizontal className="size-3.5" />
                      <span>{t.jobs.editSettings}</span>
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent>{canEdit ? t.jobs.editSettings : t.jobs.editDisabledTip}</TooltipContent>
              </Tooltip>

              {/* Chạy lại */}
              <Tooltip>
                <TooltipTrigger asChild>
                  <span>
                    <Button size="sm" variant="outline" disabled={!canRerun} onClick={() => setEditMode('rerun')}>
                      <RotateCcw className="size-3.5" />
                      <span>{t.jobs.rerun}</span>
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent>{canRerun ? t.jobs.rerun : t.jobs.rerunDisabledTip}</TooltipContent>
              </Tooltip>

              {/* Nghe voice */}
              <Tooltip>
                <TooltipTrigger asChild>
                  <span>
                    {canListen ? (
                      <Button asChild size="sm" variant="outline" className="border-primary/50 text-primary hover:bg-primary/10">
                        <Link href={`/projects/${job.projectId}/voices/${voiceId}`}>
                          <Headphones className="size-3.5" />
                          <span>{t.jobs.openVoice}</span>
                        </Link>
                      </Button>
                    ) : (
                      <Button size="sm" variant="outline" disabled>
                        <Headphones className="size-3.5" />
                        <span>{t.jobs.openVoice}</span>
                      </Button>
                    )}
                  </span>
                </TooltipTrigger>
                <TooltipContent>{canListen ? t.jobs.openVoice : t.jobs.voiceNotReadyTip}</TooltipContent>
              </Tooltip>

              {/* Xóa */}
              <Tooltip>
                <TooltipTrigger asChild>
                  <span>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={del.isPending}
                      onClick={() => setDeleteOpen(true)}
                      className="border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
                    >
                      <Trash2 className="size-3.5" />
                      <span>{t.jobs.delete}</span>
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent>{t.jobs.delete}</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </CardAction>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1.5">
            <div className="flex justify-between text-sm">
              <span>{t.jobs.progress}</span>
              <span className="text-muted-foreground">
                {done}/{total} {t.jobs.segmentsDone} ({percent}%)
                {job.timing?.parts && job.timing.parts.total > 1 ? ` · ${fmt(t.jobs.partsProgress, job.timing.parts)}` : ''}
              </span>
            </div>
            <Progress value={percent} aria-label={t.jobs.progress} />
          </div>
          <dl className="grid grid-cols-2 gap-2 text-sm text-muted-foreground sm:grid-cols-4">
            <div>
              <dt className="text-xs">{t.jobs.voice}</dt>
              <dd className="text-foreground">{job.settings.voice}</dd>
            </div>
            <div>
              <dt className="text-xs">{t.jobs.model}</dt>
              <dd className="text-foreground">{job.settings.model ?? '—'}</dd>
            </div>
            <div>
              <dt className="text-xs">{t.jobs.colCreated}</dt>
              <dd className="text-foreground">{fx.dateTime(job.createdAt)}</dd>
            </div>
            <div>
              <dt className="text-xs">{t.jobs.speed}</dt>
              <dd className="text-foreground">{job.settings.speed ?? '—'}</dd>
            </div>
          </dl>
          {finished && errorMessage ? (
            <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
              {errorMessage}
            </p>
          ) : null}
          {job.timing && job.timing.overflowCount > 0 ? (
            <p role="status" className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
              {fmt(t.jobs.overflowWarn, { n: job.timing.overflowCount })}
            </p>
          ) : null}
          {job.failedSegments.length > 0 ? (
            <div className="space-y-1">
              <p className="text-sm font-medium">{t.jobs.failedSegments}</p>
              {job.timing ? <p className="text-xs text-muted-foreground">{t.jobs.failedUnitsNote}</p> : null}
              <ul className="flex flex-wrap gap-1.5">
                {job.failedSegments.map((f) => (
                  <li key={f.idx}>
                    <Badge variant="destructive">
                      {t.jobs.segment} {f.idx + 1}: {f.errorCode}
                    </Badge>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <LogViewer logs={stream.logs} conn={stream.conn} />

      <EditSettingsDialog
        job={editMode ? job : null}
        mode={editMode ?? 'edit'}
        providerType={job.providerType}
        onClose={() => setEditMode(null)}
      />

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={t.jobs.deleteTitle}
        description={
          <>
            <p>{t.jobs.deleteDesc}</p>
            {ACTIVE.includes(status) ? <p className="text-amber-500">{t.jobs.deleteActiveDesc}</p> : null}
          </>
        }
        confirmLabel={t.jobs.delete}
        onConfirm={async () => {
          await del.mutateAsync();
        }}
      />
    </div>
  );
}
