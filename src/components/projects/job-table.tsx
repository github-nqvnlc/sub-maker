'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { RotateCcw, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { DataTable, type Column } from '@/components/shared/data-table';
import { EmptyState } from '@/components/shared/states';
import { EditSettingsDialog } from '@/components/jobs/edit-settings-dialog';
import { StatusBadge, type JobStatus } from '@/components/jobs/status-badge';
import { apiPost } from '@/lib/api-client';
import { useFormat, useT } from '@/lib/i18n/client';

export type JobRowDto = {
  id: string;
  projectId: string;
  fileId: string;
  status: JobStatus;
  configScope: 'global' | 'user';
  settings: { model: string | null; voice: string; speed: number | null; timing?: { mode: 'timed'; mergeCues: boolean } | null };
  progressDone: number;
  progressTotal: number;
  errorMessage: string | null;
  voiceId: string | null;
  createdAt: string;
};

const ACTIVE: JobStatus[] = ['queued', 'running'];
const RESUMABLE: JobStatus[] = ['stopped', 'failed', 'interrupted'];

/**
 * Danh sách tiến trình của Project: trạng thái, tiến độ và các thao tác quản lý
 * (dừng, tiếp tục, chạy lại, sửa thiết lập, xóa một hoặc nhiều) — FR-002, FR-021..023.
 */
export function JobTable({
  projectId,
  providerType,
  jobs,
  fileNames,
  onPreviewFile,
}: {
  projectId: string;
  providerType: string;
  jobs: JobRowDto[];
  fileNames: Map<string, string>;
  onPreviewFile?: (fileId: string) => void;
}) {
  const t = useT();
  const fx = useFormat();
  const qc = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [edit, setEdit] = useState<{ job: JobRowDto; mode: 'edit' | 'rerun' } | null>(null);
  const [confirmIds, setConfirmIds] = useState<string[] | null>(null);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['project', projectId] });
    void qc.invalidateQueries({ queryKey: ['projects'] });
    void qc.invalidateQueries({ queryKey: ['active-jobs'] });
  };
  const onError = (e: unknown) => toast.error(e instanceof Error ? e.message : t.common.genericError);

  const stop = useMutation({
    mutationFn: (id: string) => apiPost(`/api/jobs/${id}/stop`, {}),
    onSuccess: () => {
      toast.success(t.jobs.stopRequested);
      refresh();
    },
    onError,
  });
  const resume = useMutation({
    mutationFn: (id: string) => apiPost(`/api/jobs/${id}/resume`, {}),
    onSuccess: () => {
      toast.success(t.jobs.resumed);
      refresh();
    },
    onError,
  });
  const del = useMutation({
    mutationFn: (ids: string[]) => apiPost<{ deleted: string[]; rejectedRunning: string[] }>('/api/jobs/bulk-delete', { ids, stopFirst: true }),
    onSuccess: (r) => {
      if (r.deleted.length > 0) toast.success(t.jobs.deleted);
      if (r.rejectedRunning.length > 0) toast.error(t.jobs.busyNotice);
      setSelected(new Set());
      refresh();
    },
    onError,
  });

  if (jobs.length === 0) return <EmptyState title={t.jobs.empty} />;

  const columns: Column<JobRowDto>[] = [
    { key: 'status', header: t.jobs.colStatus, cell: (j) => <StatusBadge status={j.status} /> },
    {
      key: 'file',
      header: t.jobs.colFile,
      cell: (j) => (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onPreviewFile?.(j.fileId);
          }}
          className="line-clamp-1 max-w-48 cursor-pointer break-all text-left font-medium transition-colors hover:text-primary hover:underline"
        >
          {fileNames.get(j.fileId) ?? '—'}
        </button>
      ),
    },
    { key: 'voice', header: t.jobs.colVoice, cell: (j) => <span>{j.settings.voice}</span>, className: 'hidden sm:table-cell' },
    {
      key: 'progress',
      header: t.jobs.colProgress,
      cell: (j) => (
        <div className="flex min-w-28 items-center gap-2">
          <Progress value={j.progressTotal > 0 ? (j.progressDone / j.progressTotal) * 100 : 0} className="h-1.5 w-20" aria-label={t.jobs.progress} />
          <span className="text-xs tabular-nums text-muted-foreground">
            {j.progressDone}/{j.progressTotal}
          </span>
        </div>
      ),
    },
    { key: 'created', header: t.jobs.colCreated, cell: (j) => <span className="whitespace-nowrap text-xs">{fx.dateTime(j.createdAt)}</span>, className: 'hidden md:table-cell' },
    {
      key: 'actions',
      header: t.jobs.colActions,
      cell: (j) => (
        <div className="flex flex-wrap gap-1">
          <Button asChild size="sm" variant="outline">
            <Link href={`/projects/${j.projectId}/jobs/${j.id}`}>{t.jobs.open}</Link>
          </Button>
          {j.voiceId ? (
            <Button asChild size="sm">
              <Link href={`/projects/${j.projectId}/voices/${j.voiceId}`}>{t.voices.open}</Link>
            </Button>
          ) : null}
          {ACTIVE.includes(j.status) ? (
            <Button size="sm" variant="outline" disabled={stop.isPending} onClick={() => stop.mutate(j.id)}>
              {t.jobs.stop}
            </Button>
          ) : null}
          {RESUMABLE.includes(j.status) ? (
            <>
              <Button size="sm" variant="outline" disabled={resume.isPending} onClick={() => resume.mutate(j.id)}>
                {t.jobs.resume}
              </Button>
              <Button size="sm" variant="outline" onClick={() => setEdit({ job: j, mode: 'edit' })}>
                {t.jobs.editSettings}
              </Button>
            </>
          ) : null}
          {!ACTIVE.includes(j.status) ? (
            <Button size="sm" variant="outline" onClick={() => setEdit({ job: j, mode: 'rerun' })}>
              <RotateCcw className="size-3.5" />
              {t.jobs.rerun}
            </Button>
          ) : null}
          <Button size="icon" variant="ghost" aria-label={t.jobs.delete} onClick={() => setConfirmIds([j.id])}>
            <Trash2 className="size-4" />
          </Button>
        </div>
      ),
    },
  ];

  const confirmHasActive = jobs.some((j) => confirmIds?.includes(j.id) && ACTIVE.includes(j.status));

  return (
    <div className="space-y-3">
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

      <DataTable
        rows={jobs}
        columns={columns}
        rowId={(j) => j.id}
        selected={selected}
        onSelectedChange={setSelected}
        onRowClick={onPreviewFile ? (j) => onPreviewFile(j.fileId) : undefined}
        selectAllLabel={t.jobs.selectAll}
        selectLabel={t.jobs.selectRow}
      />

      <EditSettingsDialog job={edit?.job ?? null} mode={edit?.mode ?? 'edit'} providerType={providerType} onClose={() => setEdit(null)} />

      <ConfirmDialog
        open={!!confirmIds}
        onOpenChange={(o) => !o && setConfirmIds(null)}
        title={confirmIds && confirmIds.length > 1 ? t.jobs.deleteManyTitle : t.jobs.deleteTitle}
        description={
          <>
            <p className="font-medium text-foreground">
              {confirmIds?.length ?? 0} {t.jobs.countUnit}
            </p>
            <p>{t.jobs.deleteDesc}</p>
            {confirmHasActive ? <p>{t.jobs.deleteActiveDesc}</p> : null}
          </>
        }
        confirmLabel={t.jobs.delete}
        onConfirm={async () => {
          if (confirmIds) await del.mutateAsync(confirmIds);
        }}
      />
    </div>
  );
}
