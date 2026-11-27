'use client';

import { useEffect, useRef } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { ErrorState, LoadingList } from '@/components/shared/states';
import { GlossaryEditor } from '@/components/video/glossary-editor';
import { UploadPanel } from '@/components/video/upload-panel';
import { VideoJobList } from '@/components/video/video-job-list';
import { isVideoActive, useVideoJobs, useVideoRefresh, useVideoTab } from '@/lib/hooks/use-video';
import { useT } from '@/lib/i18n/client';

/** Vì sao chưa tạo được việc mới: thiếu quyền hoặc chưa cấu hình nhà cung cấp (FR-008, FR-013). */
function Blocked({ title, description }: { title: string; description: string }) {
  return (
    <Card>
      <CardContent className="space-y-1 p-5">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </CardContent>
    </Card>
  );
}

/** Tab "Dịch Video" của Project (spec 006, FR-001). */
export function VideoTab({ projectId }: { projectId: string }) {
  const t = useT();
  const tab = useVideoTab(projectId);
  const jobs = useVideoJobs(projectId);

  // một việc kết thúc làm thay đổi hạn mức và số việc đang chạy: làm mới số liệu
  const refresh = useVideoRefresh(projectId);
  const active = jobs.data?.filter(isVideoActive).length;
  const seen = useRef(active);
  useEffect(() => {
    if (seen.current !== undefined && active !== undefined && active < seen.current) refresh();
    seen.current = active;
  }, [active, refresh]);

  if (tab.isPending) return <LoadingList rows={4} />;
  // lỗi khi hỏi lại không được gỡ khung đang có (đang tải video, phiên vừa hết hạn)
  if (!tab.data) return <ErrorState message={t.video.loadError} onRetry={() => void tab.refetch()} />;

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h2 className="text-base font-semibold">{t.video.title}</h2>
        <p className="text-xs text-muted-foreground">{t.video.desc}</p>
      </div>
      {!tab.data.allowed ? (
        <Blocked title={t.video.notAllowedTitle} description={t.video.notAllowedDesc} />
      ) : !tab.data.sttConfigured ? (
        <Blocked title={t.video.notConfiguredTitle} description={t.video.notConfiguredDesc} />
      ) : (
        <UploadPanel projectId={projectId} tab={tab.data} jobs={jobs.data ?? []} />
      )}
      <VideoJobList projectId={projectId} allowed={tab.data.allowed} />
      <GlossaryEditor projectId={projectId} />
    </div>
  );
}
