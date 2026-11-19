'use client';

import { useEffect, useReducer } from 'react';
import type { JobStatus } from '@/components/jobs/status-badge';

export type LogEntry = {
  id: number;
  ts: string;
  level: 'info' | 'warn' | 'error';
  code: string;
  message: string;
  meta: Record<string, unknown> | null;
};

export type ConnState = 'connecting' | 'live' | 'reconnecting' | 'polling' | 'finished';

export type StreamState = {
  logs: LogEntry[];
  status: JobStatus | null;
  done: number;
  total: number;
  percent: number;
  errorCode: string | null;
  errorMessage: string | null;
  voiceId: string | null;
  conn: ConnState;
};

type Action =
  | { type: 'log'; entry: LogEntry }
  | { type: 'logs'; entries: LogEntry[] }
  | { type: 'progress'; status: JobStatus; done: number; total: number; percent: number }
  | { type: 'status'; status: JobStatus; errorCode: string | null; errorMessage: string | null; voiceId: string | null }
  | { type: 'conn'; conn: ConnState };

const initial: StreamState = {
  logs: [],
  status: null,
  done: 0,
  total: 0,
  percent: 0,
  errorCode: null,
  errorMessage: null,
  voiceId: null,
  conn: 'connecting',
};

/** Khử trùng theo `id` (nối lại SSE hoặc chuyển sang polling có thể gửi lại log đã nhận). */
function mergeLogs(existing: LogEntry[], incoming: LogEntry[]): LogEntry[] {
  const maxId = existing.at(-1)?.id ?? 0;
  const fresh = incoming.filter((e) => e.id > maxId).sort((a, b) => a.id - b.id);
  return fresh.length ? [...existing, ...fresh] : existing;
}

function reducer(state: StreamState, a: Action): StreamState {
  switch (a.type) {
    case 'log':
      return { ...state, logs: mergeLogs(state.logs, [a.entry]) };
    case 'logs':
      return { ...state, logs: mergeLogs(state.logs, a.entries) };
    case 'progress':
      return { ...state, status: a.status, done: a.done, total: a.total, percent: a.percent };
    case 'status':
      return { ...state, status: a.status, errorCode: a.errorCode, errorMessage: a.errorMessage, voiceId: a.voiceId };
    case 'conn':
      return state.conn === 'finished' ? state : { ...state, conn: a.conn };
  }
}

const TERMINAL = new Set<string>(['completed', 'failed', 'stopped']);
const POLL_MS = 2000;
/** Số lần SSE lỗi liên tiếp (không nhận được gì) trước khi chuyển sang polling dự phòng. */
const MAX_SSE_ERRORS = 3;

/**
 * Theo dõi log + tiến độ của một tiến trình theo thời gian thực (FR-019).
 * - Dùng SSE (`/api/jobs/{id}/events`); EventSource tự nối lại và gửi `Last-Event-ID`.
 * - Nếu SSE liên tục lỗi (bị proxy chặn…) thì chuyển sang polling `/logs?after=` mỗi 2 giây với cùng con trỏ.
 */
export function useJobStream(jobId: string): StreamState {
  const [state, dispatch] = useReducer(reducer, initial);

  useEffect(() => {
    let closed = false;
    let es: EventSource | null = null;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let lastId = 0;
    let errorStreak = 0;

    const remember = (e: LogEntry) => {
      if (e.id > lastId) lastId = e.id;
    };

    const stop = () => {
      closed = true;
      es?.close();
      if (pollTimer) clearTimeout(pollTimer);
    };

    const poll = async () => {
      if (closed) return;
      try {
        const [logsRes, jobRes] = await Promise.all([
          fetch(`/api/jobs/${jobId}/logs?after=${lastId}&limit=500`, { credentials: 'same-origin' }),
          fetch(`/api/jobs/${jobId}`, { credentials: 'same-origin' }),
        ]);
        if (logsRes.ok) {
          const body = (await logsRes.json()) as { items: LogEntry[] };
          body.items.forEach(remember);
          dispatch({ type: 'logs', entries: body.items });
        }
        if (jobRes.ok) {
          const j = (await jobRes.json()) as {
            status: JobStatus;
            progressDone: number;
            progressTotal: number;
            errorCode: string | null;
            errorMessage: string | null;
            voiceId: string | null;
          };
          const percent = j.progressTotal > 0 ? Math.round((j.progressDone / j.progressTotal) * 100) : 0;
          dispatch({ type: 'progress', status: j.status, done: j.progressDone, total: j.progressTotal, percent });
          dispatch({ type: 'status', status: j.status, errorCode: j.errorCode, errorMessage: j.errorMessage, voiceId: j.voiceId });
          if (TERMINAL.has(j.status)) {
            // Job đã kết thúc: lấy nốt log còn lại (có thể phát sinh giữa hai lần gọi) rồi dừng
            const tail = await fetch(`/api/jobs/${jobId}/logs?after=${lastId}&limit=500`, { credentials: 'same-origin' });
            if (tail.ok) {
              const rest = ((await tail.json()) as { items: LogEntry[] }).items;
              rest.forEach(remember);
              dispatch({ type: 'logs', entries: rest });
            }
            dispatch({ type: 'conn', conn: 'finished' });
            stop();
            return;
          }
        }
      } catch {
        /* thử lại ở vòng sau */
      }
      pollTimer = setTimeout(() => void poll(), POLL_MS);
    };

    const startPolling = () => {
      es?.close();
      es = null;
      dispatch({ type: 'conn', conn: 'polling' });
      void poll();
    };

    const connect = () => {
      es = new EventSource(`/api/jobs/${jobId}/events`);
      es.addEventListener('open', () => {
        errorStreak = 0;
        dispatch({ type: 'conn', conn: 'live' });
      });
      es.addEventListener('log', (ev) => {
        const entry = JSON.parse((ev as MessageEvent).data) as LogEntry;
        remember(entry);
        errorStreak = 0;
        dispatch({ type: 'log', entry });
      });
      es.addEventListener('progress', (ev) => {
        const d = JSON.parse((ev as MessageEvent).data) as { status: JobStatus; done: number; total: number; percent: number };
        dispatch({ type: 'progress', ...d });
      });
      es.addEventListener('status', (ev) => {
        const d = JSON.parse((ev as MessageEvent).data) as { status: JobStatus; errorCode: string | null; errorMessage: string | null; voiceId: string | null };
        dispatch({ type: 'status', ...d });
      });
      es.addEventListener('end', () => {
        dispatch({ type: 'conn', conn: 'finished' });
        stop();
      });
      es.addEventListener('error', () => {
        if (closed) return;
        errorStreak += 1;
        if (errorStreak >= MAX_SSE_ERRORS || es?.readyState === EventSource.CLOSED) {
          startPolling();
        } else {
          dispatch({ type: 'conn', conn: 'reconnecting' });
        }
      });
    };

    connect();
    return stop;
  }, [jobId]);

  return state;
}
