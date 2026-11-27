'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { api, apiDelete, apiPost } from '@/lib/api-client';
import type { VideoJobDetailDto, VideoJobDto, VideoLogDto, VideoTabDto } from '@/lib/video/service';
import { isBusyStatus } from '@/lib/video/status';
import { forgetLocalVideo, uploadRegistry, type UploadSnapshot } from '@/lib/video/upload-client';

/** Dữ liệu dịch video (spec 006) như API trả về. */
export type { VideoJobDetailDto, VideoJobDto, VideoLogDto, VideoTabDto };

/** Danh sách hỏi lại khi còn việc chạy: tiến độ tới người xem trong vòng 2 giây (FR-048). */
const LIST_POLL_MS = 2000;
/** Số lần luồng sự kiện lỗi liên tiếp trước khi chuyển sang hỏi định kỳ. */
const MAX_SSE_ERRORS = 3;

export const videoKeys = {
  tab: (projectId: string) => ['video-tab', projectId] as const,
  jobs: (projectId: string) => ['video-jobs', projectId] as const,
  job: (jobId: string) => ['video-job', jobId] as const,
};

/** Còn việc gì đang diễn ra ở máy chủ hoặc đang tải lên. */
export const isVideoActive = (j: Pick<VideoJobDto, 'displayStatus' | 'previewState' | 'upload'>): boolean =>
  isBusyStatus(j.displayStatus) || j.previewState === 'pending' || !!j.upload;

export function useVideoTab(projectId: string) {
  return useQuery({ queryKey: videoKeys.tab(projectId), queryFn: () => api<VideoTabDto>(`/api/projects/${projectId}/video`) });
}

export function useVideoJobs(projectId: string) {
  return useQuery({
    queryKey: videoKeys.jobs(projectId),
    queryFn: () => api<VideoJobDto[]>(`/api/projects/${projectId}/video/jobs`),
    refetchInterval: (q) => (q.state.data?.some(isVideoActive) ? LIST_POLL_MS : false),
  });
}

export function useVideoJob(jobId: string | null) {
  return useQuery({
    queryKey: videoKeys.job(jobId ?? ''),
    enabled: !!jobId,
    queryFn: () => api<VideoJobDetailDto>(`/api/video/jobs/${jobId}`),
    // tải lại video nguồn và kiểm tệp không đổi trạng thái việc nên luồng sự kiện không báo: hỏi lại
    refetchInterval: (q) => (q.state.data && (q.state.data.sourceState === 'checking' || q.state.data.upload) ? LIST_POLL_MS : false),
  });
}

/**
 * Cập nhật chi tiết một việc theo thời gian thực qua SSE (`/api/video/jobs/{id}/events`), theo cách của `use-job-stream`: trình duyệt
 * tự nối lại với `Last-Event-ID`; lỗi liên tiếp thì chuyển sang hỏi lại mỗi 2 giây. `watch` đổi (ví dụ vừa chạy lại) thì mở lại luồng.
 */
export function useVideoEvents(jobId: string | null, watch: string = ''): { connected: boolean } {
  const qc = useQueryClient();
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!jobId) return;
    let closed = false;
    let errors = 0;
    let timer: ReturnType<typeof setInterval> | null = null;
    const es = new EventSource(`/api/video/jobs/${jobId}/events`);
    const patch = (fn: (old: VideoJobDetailDto) => VideoJobDetailDto) => qc.setQueryData<VideoJobDetailDto>(videoKeys.job(jobId), (old) => (old ? fn(old) : old));
    const refresh = () => void qc.invalidateQueries({ queryKey: videoKeys.job(jobId) });

    es.addEventListener('open', () => {
      errors = 0;
      setConnected(true);
    });
    es.addEventListener('log', (ev) => {
      errors = 0;
      const entry = JSON.parse((ev as MessageEvent).data) as VideoLogDto;
      patch((old) => (old.logs.some((l) => l.id === entry.id) ? old : { ...old, logs: [...old.logs, entry].slice(-200) }));
    });
    es.addEventListener('status', (ev) => {
      const dto = JSON.parse((ev as MessageEvent).data) as VideoJobDto;
      patch((old) => ({ ...old, ...dto }));
      // media, bản xuất và kiểu không nằm trong sự kiện: tải lại khi trạng thái đổi
      refresh();
    });
    es.addEventListener('progress', (ev) => {
      const d = JSON.parse((ev as MessageEvent).data) as { percent: number };
      patch((old) => ({ ...old, progressPercent: d.percent }));
    });
    es.addEventListener('end', () => {
      closed = true;
      es.close();
      refresh();
    });
    es.addEventListener('error', () => {
      if (closed) return;
      errors += 1;
      setConnected(false);
      if (errors < MAX_SSE_ERRORS && es.readyState !== EventSource.CLOSED) return;
      es.close();
      timer ??= setInterval(refresh, LIST_POLL_MS);
    });

    return () => {
      closed = true;
      es.close();
      if (timer) clearInterval(timer);
    };
  }, [jobId, qc, watch]);

  return { connected };
}

/** Làm mới dữ liệu tab (hạn mức) và danh sách việc. */
export function useVideoRefresh(projectId: string) {
  const qc = useQueryClient();
  return useCallback(() => {
    void qc.invalidateQueries({ queryKey: videoKeys.tab(projectId) });
    void qc.invalidateQueries({ queryKey: videoKeys.jobs(projectId) });
    void qc.invalidateQueries({ queryKey: ['dashboard'] });
  }, [qc, projectId]);
}

export function useVideoActions(projectId: string) {
  const refresh = useVideoRefresh(projectId);
  const stop = useMutation({ mutationFn: (id: string) => apiPost<{ status: string }>(`/api/video/jobs/${id}/stop`), onSettled: refresh });
  const rerun = useMutation({ mutationFn: (id: string) => apiPost<VideoJobDto>(`/api/video/jobs/${id}/rerun`), onSettled: refresh });
  const remove = useMutation({
    mutationFn: async (id: string) => {
      uploadRegistry.get(id)?.pause();
      await apiDelete(`/api/video/jobs/${id}`);
      uploadRegistry.remove(id);
      forgetLocalVideo(id);
    },
    onSettled: refresh,
  });
  const removeMany = useMutation({
    mutationFn: async (ids: string[]) => {
      for (const id of ids) uploadRegistry.get(id)?.pause();
      const result = await apiPost<{ deleted: string[]; notFound: string[] }>('/api/video/jobs/bulk-delete', { ids });
      for (const id of result.deleted) {
        uploadRegistry.remove(id);
        forgetLocalVideo(id);
      }
      return result;
    },
    onSettled: refresh,
  });
  return { stop, rerun, remove, removeMany };
}

const idle = () => null;

/** Trạng thái lượt tải đang chạy trong trình duyệt của một việc (null nếu việc không được tải từ tab này). */
export function useLiveUpload(jobId: string | null): UploadSnapshot | null {
  return useSyncExternalStore(uploadRegistry.subscribe, () => (jobId ? (uploadRegistry.get(jobId)?.getSnapshot() ?? null) : null), idle);
}

/** Đổi mỗi khi bất kỳ lượt tải nào thay đổi: dùng cho danh sách. */
export function useUploadVersion(): number {
  return useSyncExternalStore(uploadRegistry.subscribe, uploadRegistry.version, () => 0);
}
