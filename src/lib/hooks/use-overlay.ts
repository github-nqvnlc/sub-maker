'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, apiPost } from '@/lib/api-client';
import type { OverlayConfig } from '@/lib/overlay/config';
import type { AppliedCue, OverlayWarning } from '@/lib/overlay/types';

/** Dữ liệu video overlay (spec 005) như API trả về. */
export type OverlaySource = { voiceId?: string | null; audioId?: string | null; fileId?: string | null };
export type OverlayLimits = { maxMinutes: number; maxMinutesTransparent: number; maxJobsPerUser: number; quotaBytes: number; usedBytes: number; pendingBytes: number };
export type OverlayStateDto = { config: OverlayConfig; source: OverlaySource; limits: OverlayLimits };
export type OverlayTimelineDto = { durationMs: number; cues: AppliedCue[]; warnings: OverlayWarning[] };
export type OverlayStatus = 'queued' | 'running' | 'completed' | 'failed' | 'stopped' | 'interrupted';
export type OverlayJobDto = {
  id: string;
  projectId: string;
  sourceNames: { voice: string; subtitle: string };
  config: OverlayConfig;
  format: OverlayConfig['format'];
  width: number;
  height: number;
  durationMs: number;
  estimatedBytes: number;
  sizeBytes: number | null;
  warnings: OverlayWarning[];
  status: OverlayStatus;
  progressPercent: number;
  errorCode: string | null;
  canRerun: boolean;
  createdAt: string;
};
export type OverlayLogDto = { id: number; ts: string; level: 'info' | 'warn' | 'error'; messageKey: string; params: Record<string, string | number> | null };
export type OverlayAudioDto = {
  id: string;
  originalName: string;
  status: 'processing' | 'ready' | 'failed';
  sizeBytes: number;
  durationMs: number | null;
  errorCode: string | null;
  createdAt: string;
};
export type OverlayDeleteResult = { deleted: string[]; busy: string[]; notFound: string[] };

export const OVERLAY_ACTIVE: ReadonlySet<OverlayStatus> = new Set(['queued', 'running', 'interrupted']);
/** Nhịp hỏi lại khi còn việc chạy: tiến độ tới người xem trong vòng 2 giây (FR-036). */
const POLL_MS = 1000;
/** Chờ sau lần chỉnh cuối rồi mới lưu cấu hình (FR-016). */
const SAVE_DELAY_MS = 800;

export const overlayKeys = {
  state: (projectId: string) => ['overlay', projectId] as const,
  jobs: (projectId: string) => ['overlay-jobs', projectId] as const,
  job: (jobId: string) => ['overlay-job', jobId] as const,
  audios: (projectId: string) => ['overlay-audios', projectId] as const,
  timeline: (projectId: string, s: OverlaySource) => ['overlay-timeline', projectId, s.voiceId ?? null, s.audioId ?? null, s.fileId ?? null] as const,
};

// ---- Đọc ----------------------------------------------------------------------------------------

export function useOverlayState(projectId: string) {
  return useQuery({ queryKey: overlayKeys.state(projectId), queryFn: () => api<OverlayStateDto>(`/api/projects/${projectId}/overlay`) });
}

/** Mốc áp dụng cho cặp voice và phụ đề; chỉ hỏi khi đã chọn đủ. Đổi phụ đề của cùng một voice thì giữ dữ liệu cũ trong lúc tải để không ngắt tiếng. */
export function useOverlayTimeline(projectId: string, s: OverlaySource, enabled: boolean) {
  const q = new URLSearchParams();
  if (s.voiceId) q.set('voiceId', s.voiceId);
  if (s.audioId) q.set('audioId', s.audioId);
  if (s.fileId) q.set('fileId', s.fileId);
  return useQuery({
    queryKey: overlayKeys.timeline(projectId, s),
    enabled: enabled && !!s.fileId && !!(s.voiceId ?? s.audioId),
    queryFn: () => api<OverlayTimelineDto>(`/api/projects/${projectId}/overlay/timeline?${q}`),
    staleTime: 60_000,
    placeholderData: (prev, prevQuery) => {
      const k = prevQuery?.queryKey as ReturnType<typeof overlayKeys.timeline> | undefined;
      return k && k[1] === projectId && k[2] === (s.voiceId ?? null) && k[3] === (s.audioId ?? null) ? prev : undefined;
    },
  });
}

/** Các lần xuất của Project; hỏi lại mỗi giây khi còn việc chờ/chạy. */
export function useOverlayJobs(projectId: string) {
  return useQuery({
    queryKey: overlayKeys.jobs(projectId),
    queryFn: () => api<OverlayJobDto[]>(`/api/projects/${projectId}/overlay/jobs`),
    refetchInterval: (q) => (q.state.data?.some((j) => OVERLAY_ACTIVE.has(j.status)) ? POLL_MS : false),
  });
}

/** Chi tiết + nhật ký một lần xuất. */
export function useOverlayJob(jobId: string | null) {
  return useQuery({
    queryKey: overlayKeys.job(jobId ?? ''),
    enabled: !!jobId,
    queryFn: () => api<OverlayJobDto & { logs: OverlayLogDto[] }>(`/api/overlay/jobs/${jobId}`),
    refetchInterval: (q) => (q.state.data && OVERLAY_ACTIVE.has(q.state.data.status) ? POLL_MS : false),
  });
}

export function useOverlayAudios(projectId: string) {
  return useQuery({
    queryKey: overlayKeys.audios(projectId),
    queryFn: () => api<OverlayAudioDto[]>(`/api/projects/${projectId}/overlay/audios`),
    refetchInterval: (q) => (q.state.data?.some((a) => a.status === 'processing') ? POLL_MS : false),
  });
}

// ---- Ghi ----------------------------------------------------------------------------------------

/** Làm mới dữ liệu overlay và các số liệu dung lượng liên quan. */
export function useOverlayRefresh(projectId: string) {
  const qc = useQueryClient();
  return useCallback(() => {
    void qc.invalidateQueries({ queryKey: overlayKeys.state(projectId) });
    void qc.invalidateQueries({ queryKey: overlayKeys.jobs(projectId) });
    void qc.invalidateQueries({ queryKey: overlayKeys.audios(projectId) });
    void qc.invalidateQueries({ queryKey: ['dashboard'] });
  }, [qc, projectId]);
}

type Saved = { config: OverlayConfig; source: OverlaySource };

/**
 * Tự lưu cấu hình gần nhất (FR-016): chờ 800 ms sau lần chỉnh cuối; rời tab hay đóng trang thì lưu ngay. Lỗi không làm mất thay đổi trên
 * màn hình: lần chỉnh sau (hoặc lúc rời trang) gửi lại bản mới nhất.
 */
export function useOverlayAutosave(projectId: string) {
  const qc = useQueryClient();
  const [failed, setFailed] = useState(false);
  const pending = useRef<Saved | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const chain = useRef<Promise<unknown>>(Promise.resolve());

  const remember = useCallback((v: Saved) => qc.setQueryData<OverlayStateDto>(overlayKeys.state(projectId), (old) => (old ? { ...old, ...v } : old)), [qc, projectId]);

  const flush = useCallback(
    (leaving = false) => {
      clearTimeout(timer.current);
      const body = pending.current;
      if (!body) return;
      pending.current = null;
      const put = () => api(`/api/projects/${projectId}/overlay`, { method: 'PUT', json: body, keepalive: leaving });
      // gửi lần lượt để bản cũ không ghi đè bản mới; đang rời trang thì gửi ngay
      const sent = leaving ? put() : chain.current.then(put);
      chain.current = sent.then(
        () => {
          if (!pending.current) remember(body);
          setFailed(false);
        },
        () => {
          pending.current ??= body;
          setFailed(true);
        },
      );
    },
    [projectId, remember],
  );

  const save = useCallback(
    (v: Saved) => {
      pending.current = v;
      // cập nhật ngay bản trong bộ nhớ để rời tab rồi quay lại không mất thay đổi
      remember(v);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => flush(), SAVE_DELAY_MS);
    },
    [flush, remember],
  );

  useEffect(() => {
    const leave = () => flush(true);
    window.addEventListener('pagehide', leave);
    return () => {
      window.removeEventListener('pagehide', leave);
      flush(true);
    };
  }, [flush]);

  return { save, failed };
}

/** Mã yêu cầu do trình duyệt sinh để gửi lại không tạo hai lần xuất. `crypto.randomUUID` chỉ có ở ngữ cảnh an toàn (HTTPS/localhost). */
export function newRequestId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export type CreateOverlayJob = OverlaySource & { clientRequestId: string; config: OverlayConfig };

export function useOverlayActions(projectId: string) {
  const refresh = useOverlayRefresh(projectId);
  const create = useMutation({ mutationFn: (body: CreateOverlayJob) => apiPost<OverlayJobDto>(`/api/projects/${projectId}/overlay/jobs`, body), onSettled: refresh });
  const stop = useMutation({ mutationFn: (id: string) => apiPost(`/api/overlay/jobs/${id}/stop`), onSettled: refresh });
  const rerun = useMutation({ mutationFn: (id: string) => apiPost<OverlayJobDto>(`/api/overlay/jobs/${id}/rerun`), onSettled: refresh });
  const remove = useMutation({ mutationFn: (ids: string[]) => apiPost<OverlayDeleteResult>('/api/overlay/jobs/bulk-delete', { ids }), onSettled: refresh });
  return { create, stop, rerun, remove };
}

export function useOverlayAudioActions(projectId: string) {
  const refresh = useOverlayRefresh(projectId);
  const upload = useMutation({
    mutationFn: (file: File) => {
      const form = new FormData();
      form.set('file', file);
      return api<OverlayAudioDto>(`/api/projects/${projectId}/overlay/audios`, { method: 'POST', body: form });
    },
    onSettled: refresh,
  });
  const remove = useMutation({ mutationFn: (ids: string[]) => apiPost<OverlayDeleteResult>('/api/overlay/audios/bulk-delete', { ids }), onSettled: refresh });
  return { upload, remove };
}
