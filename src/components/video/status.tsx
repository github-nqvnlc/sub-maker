'use client';

import { StatusBadge, type JobStatus } from '@/components/jobs/status-badge';
import { useT } from '@/lib/i18n/client';
import type { VideoDisplayStatus } from '@/lib/video/status';

/** Tông màu của từng trạng thái dịch video (FR-048): đang làm dùng tông `running`, chờ duyệt dùng tông `queued`. */
const TONE: Record<VideoDisplayStatus, JobStatus> = {
  waiting_media: 'running',
  queued: 'queued',
  preparing: 'running',
  translating: 'running',
  review_ready: 'queued',
  exporting: 'running',
  completed: 'completed',
  stopped: 'stopped',
  failed: 'failed',
  interrupted: 'interrupted',
};

export function VideoStatusBadge({ status }: { status: VideoDisplayStatus }) {
  const t = useT();
  return <StatusBadge status={TONE[status]} label={t.video.status[status]} />;
}
