'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Progress } from '@/components/ui/progress';
import { StatusBadge, type JobStatus } from '@/components/jobs/status-badge';
import { api } from '@/lib/api-client';
import { vi } from '@/lib/i18n/vi';

type ActiveJob = { id: string; projectId: string; status: JobStatus; settings: { voice: string }; progressDone: number; progressTotal: number };

/**
 * Chỉ báo "Tiến trình đang chạy" ở tiêu đề (xuyên mọi Project): người dùng rời màn hình tạo voice vẫn thấy tiến độ
 * và quay lại được (FR-018, US2). Cập nhật định kỳ bằng API danh sách tiến trình của tôi.
 */
export function ActiveJobs() {
  const q = useQuery({
    queryKey: ['active-jobs'],
    queryFn: () => api<ActiveJob[]>('/api/jobs?status=running,queued,interrupted&limit=20'),
    refetchInterval: 4000,
  });
  const jobs = q.data ?? [];
  if (jobs.length === 0) return null;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2" aria-label={vi.activeJobs.title}>
          <Loader2 className="size-4 animate-spin" aria-hidden />
          <span>
            {jobs.length} {vi.activeJobs.count}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 space-y-2 p-3">
        <p className="text-sm font-medium">{vi.activeJobs.title}</p>
        <ul className="space-y-2">
          {jobs.map((j) => (
            <li key={j.id}>
              <Link href={`/projects/${j.projectId}/jobs/${j.id}`} className="block rounded-md border p-2 hover:bg-accent/50">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm">{j.settings.voice}</span>
                  <StatusBadge status={j.status} />
                </div>
                <Progress value={j.progressTotal > 0 ? (j.progressDone / j.progressTotal) * 100 : 0} className="mt-2 h-1.5" />
                <p className="mt-1 text-xs text-muted-foreground">
                  {j.progressDone}/{j.progressTotal}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
