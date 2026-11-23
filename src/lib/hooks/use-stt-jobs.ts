'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api-client';

/** STT job (spec 004) như API trả về. */
export type SttStatus = 'queued' | 'extracting' | 'uploading' | 'transcribing' | 'formatting' | 'completed' | 'failed' | 'interrupted';
export type SttJobDto = {
  id: string;
  projectId: string;
  originalFileName: string;
  mediaType: 'audio' | 'video';
  targetFormat: 'srt' | 'txt' | 'md';
  targetFileName: string;
  language: string;
  enableDiarization: boolean;
  status: SttStatus;
  progressPercent: number;
  errorCode: string | null;
  errorMessage: string | null;
  resultSubtitleFileId: string | null;
  createdAt: string;
};
export type SttLogDto = { id: number; ts: string; level: 'info' | 'warn' | 'error'; messageKey: string; params: Record<string, string | number> | null };

export const STT_ACTIVE: ReadonlySet<SttStatus> = new Set(['queued', 'extracting', 'uploading', 'transcribing', 'formatting', 'interrupted']);

/** Danh sách STT job của Project; poll mỗi 2 giây khi còn job đang chờ/chạy (FR-006, Hiến pháp III). */
export function useSttJobs(projectId: string) {
  return useQuery({
    queryKey: ['stt-jobs', projectId],
    queryFn: () => api<SttJobDto[]>(`/api/projects/${projectId}/stt`),
    refetchInterval: (q) => (q.state.data?.some((j) => STT_ACTIVE.has(j.status)) ? 2000 : false),
  });
}

/** Chi tiết + nhật ký một STT job; poll mỗi 2 giây khi job còn chạy, dừng khi hoàn tất/lỗi. */
export function useSttJob(jobId: string | null) {
  return useQuery({
    queryKey: ['stt-job', jobId],
    enabled: !!jobId,
    queryFn: () => api<SttJobDto & { logs: SttLogDto[] }>(`/api/stt/${jobId}`),
    refetchInterval: (q) => (q.state.data && STT_ACTIVE.has(q.state.data.status) ? 2000 : false),
  });
}
