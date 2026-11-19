'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { ErrorState, LoadingList } from '@/components/shared/states';
import { LogViewer } from '@/components/jobs/log-viewer';
import { StatusBadge, type JobStatus } from '@/components/jobs/status-badge';
import { api } from '@/lib/api-client';
import { fmtDateTime } from '@/lib/format';
import { useJobStream } from '@/lib/hooks/use-job-stream';
import { vi } from '@/lib/i18n/vi';

type JobDetail = {
  id: string;
  projectId: string;
  fileId: string;
  status: JobStatus;
  configScope: 'global' | 'user';
  settings: { model: string | null; voice: string; speed: number | null };
  progressDone: number;
  progressTotal: number;
  errorCode: string | null;
  errorMessage: string | null;
  voiceId: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  failedSegments: { idx: number; errorCode: string }[];
};

/** Màn hình theo dõi một tiến trình: trạng thái, tiến độ, log thời gian thực, đoạn lỗi (FR-019, FR-020). */
export function JobMonitor({ jobId }: { jobId: string }) {
  const stream = useJobStream(jobId);
  const finished = stream.status === 'completed' || stream.status === 'failed' || stream.status === 'stopped';

  const detail = useQuery({
    // Tải lại chi tiết khi trạng thái đổi để có đoạn lỗi/voiceId mới nhất
    queryKey: ['job', jobId, stream.status],
    queryFn: () => api<JobDetail>(`/api/jobs/${jobId}`),
  });

  if (detail.isPending) return <LoadingList rows={3} />;
  if (detail.isError) return <ErrorState message={detail.error.message} onRetry={() => void detail.refetch()} />;
  const job = detail.data;
  const status = stream.status ?? job.status;
  const done = stream.total > 0 ? stream.done : job.progressDone;
  const total = stream.total > 0 ? stream.total : job.progressTotal;
  const percent = total > 0 ? Math.round((done / total) * 100) : 0;
  const voiceId = stream.voiceId ?? job.voiceId;
  const errorMessage = stream.errorMessage ?? job.errorMessage;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex-row flex-wrap items-center justify-between gap-2 space-y-0">
          <CardTitle className="flex items-center gap-2 text-lg">
            <StatusBadge status={status} />
            <Badge variant="secondary">{job.configScope === 'user' ? vi.jobs.scopeUser : vi.jobs.scopeGlobal}</Badge>
          </CardTitle>
          <div className="flex gap-2">
            <Button asChild variant="outline" size="sm">
              <Link href={`/projects/${job.projectId}`}>{vi.jobs.backToProject}</Link>
            </Button>
            {voiceId ? (
              <Button asChild size="sm">
                <Link href={`/projects/${job.projectId}/voices/${voiceId}`}>{vi.jobs.openVoice}</Link>
              </Button>
            ) : null}
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1.5">
            <div className="flex justify-between text-sm">
              <span>{vi.jobs.progress}</span>
              <span className="text-muted-foreground">
                {done}/{total} {vi.jobs.segmentsDone} ({percent}%)
              </span>
            </div>
            <Progress value={percent} aria-label={vi.jobs.progress} />
          </div>
          <dl className="grid grid-cols-2 gap-2 text-sm text-muted-foreground sm:grid-cols-4">
            <div>
              <dt className="text-xs">{vi.jobs.voice}</dt>
              <dd className="text-foreground">{job.settings.voice}</dd>
            </div>
            <div>
              <dt className="text-xs">{vi.jobs.model}</dt>
              <dd className="text-foreground">{job.settings.model ?? '—'}</dd>
            </div>
            <div>
              <dt className="text-xs">{vi.jobs.colCreated}</dt>
              <dd className="text-foreground">{fmtDateTime(job.createdAt)}</dd>
            </div>
            <div>
              <dt className="text-xs">{vi.jobs.speed}</dt>
              <dd className="text-foreground">{job.settings.speed ?? '—'}</dd>
            </div>
          </dl>
          {finished && errorMessage ? (
            <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
              {errorMessage}
            </p>
          ) : null}
          {job.failedSegments.length > 0 ? (
            <div className="space-y-1">
              <p className="text-sm font-medium">{vi.jobs.failedSegments}</p>
              <ul className="flex flex-wrap gap-1.5">
                {job.failedSegments.map((f) => (
                  <li key={f.idx}>
                    <Badge variant="destructive">
                      {vi.jobs.segment} {f.idx + 1}: {f.errorCode}
                    </Badge>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <LogViewer logs={stream.logs} conn={stream.conn} />
    </div>
  );
}
