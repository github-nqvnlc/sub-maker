import { extractAudioInWorkerCore, type ClientAudioResult } from './extract-audio-core';

export type ExtractWorkerRequest = { id: string; file: File; timeoutMs?: number };
export type ExtractWorkerResponse = { id: string; result: ClientAudioResult };

const running = new Map<string, AbortController>();

/** Web Worker tách âm thanh bằng `mediabunny` (spec 006, T127). */
self.onmessage = async (event: MessageEvent<ExtractWorkerRequest | { type: 'abort'; id: string }>) => {
  const data = event.data;
  if ('type' in data && data.type === 'abort') {
    running.get(data.id)?.abort();
    running.delete(data.id);
    return;
  }
  const req = data as ExtractWorkerRequest;
  const controller = new AbortController();
  running.set(req.id, controller);
  const result = await extractAudioInWorkerCore(req.file, { signal: controller.signal, timeoutMs: req.timeoutMs });
  running.delete(req.id);
  const payload: ExtractWorkerResponse = { id: req.id, result };
  if (result.ok) {
    (self as unknown as { postMessage: (msg: unknown, transfer: Transferable[]) => void }).postMessage(payload, [result.buffer]);
  } else {
    self.postMessage(payload);
  }
};

