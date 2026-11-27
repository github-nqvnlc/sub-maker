import { CLIENT_AUDIO_TIMEOUT_MS, extensionOfFastVideo, type ClientAudioResult } from './extract-audio-core';
import type { ClientAudioExtension } from './types';

export { CLIENT_AUDIO_MAX_BYTES, CLIENT_AUDIO_TIMEOUT_MS, CLIENT_AUDIO_TRANSCODE_THRESHOLD_BYTES, extensionOfFastVideo, selectAudioOutputPlan, type AudioOutputPlan } from './extract-audio-core';

export type ClientAudioExtract =
  | { ok: true; blob: Blob; ext: ClientAudioExtension; mime: string; startMs: number; durationMs: number }
  | { ok: false; reason: string };

/** Kiểm tra thiết bị và phần mở rộng đủ điều kiện tách âm thanh nhanh ở trình duyệt (research R8, T127). */
export function checkClientAudioCapability(
  fileName: string,
  env?: { hasWorker?: boolean; deviceMemory?: number; hardwareConcurrency?: number },
): { ok: true } | { ok: false; reason: string } {
  if (!extensionOfFastVideo(fileName)) return { ok: false, reason: 'unsupported_ext' };
  const hasWorker = env?.hasWorker ?? typeof Worker !== 'undefined';
  if (!hasWorker) return { ok: false, reason: 'no_worker' };
  const mem = env && 'deviceMemory' in env ? env.deviceMemory : typeof navigator !== 'undefined' ? (navigator as { deviceMemory?: number }).deviceMemory : undefined;
  if (typeof mem === 'number') {
    return mem >= 4 ? { ok: true } : { ok: false, reason: 'low_memory' };
  }
  const cpu = env?.hardwareConcurrency ?? (typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : 0);
  return cpu >= 4 ? { ok: true } : { ok: false, reason: 'low_cpu' };
}

export const canExtractClientAudio = (fileName: string): boolean => checkClientAudioCapability(fileName).ok;

const activeJobs = new Map<string, AbortController>();

/** Hủy luồng tách/tải âm thanh nhanh nếu người dùng hủy hoặc xóa việc đang chạy. */
export function abortClientAudioJob(jobId: string): void {
  const c = activeJobs.get(jobId);
  if (c) {
    c.abort();
    activeJobs.delete(jobId);
  }
}

export function trackClientAudioJob(jobId: string): AbortController {
  abortClientAudioJob(jobId);
  const c = new AbortController();
  activeJobs.set(jobId, c);
  return c;
}

export function clearClientAudioJob(jobId: string): void {
  activeJobs.delete(jobId);
}

/** Chạy tách âm thanh trong Web Worker kèm thời gian chờ 5 phút; lỗi gì cũng trả `{ ok: false }` để rơi về luồng máy chủ trong im lặng. */
export async function extractClientAudio(file: File, opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<ClientAudioExtract> {
  const cap = checkClientAudioCapability(file.name);
  if (!cap.ok) return cap;

  return new Promise<ClientAudioExtract>((resolve) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL('./extract-audio.worker.ts', import.meta.url), { type: 'module' });
    } catch {
      resolve({ ok: false, reason: 'worker_init_failed' });
      return;
    }
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const timeoutMs = opts.timeoutMs ?? CLIENT_AUDIO_TIMEOUT_MS;
    let settled = false;
    const finish = (res: ClientAudioExtract) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      worker.terminate();
      resolve(res);
    };
    const onAbort = () => {
      try {
        worker.postMessage({ type: 'abort', id });
      } catch {
        /* đóng ngay */
      }
      finish({ ok: false, reason: 'aborted' });
    };
    const timer = setTimeout(() => {
      try {
        worker.postMessage({ type: 'abort', id });
      } catch {
        /* đóng ngay */
      }
      finish({ ok: false, reason: 'timeout' });
    }, timeoutMs);

    if (opts.signal?.aborted) return finish({ ok: false, reason: 'aborted' });
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    worker.onmessage = (e: MessageEvent<{ id: string; result: ClientAudioResult }>) => {
      if (e.data?.id !== id) return;
      const r = e.data.result;
      if (!r.ok) return finish(r);
      finish({ ok: true, blob: new Blob([r.buffer], { type: r.mime }), ext: r.ext, mime: r.mime, startMs: r.startMs, durationMs: r.durationMs });
    };
    worker.onerror = () => finish({ ok: false, reason: 'worker_error' });
    worker.postMessage({ id, file, timeoutMs });
  });
}
