/**
 * Tải video từng phần ở trình duyệt (spec 006, contracts/render-and-media.md §5; FR-004 đến FR-006):
 * `idle → uploading ⇄ paused → completing → done`. Ba phần song song bằng XMLHttpRequest (có tiến độ tải lên). Lỗi mạng, 429, 5xx
 * thử lại sau 1, 2, 4, 8, 16 giây rồi tạm dừng; 401 tạm dừng và yêu cầu đăng nhập; 403/404/409 dừng hẳn và báo lỗi.
 * Không phụ thuộc React: một lượt tải sống tiếp khi người dùng chuyển trang trong ứng dụng.
 */
import { holdLoginRedirect } from '../api-client';

export const UPLOAD_PARALLEL = 3;
export const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 16_000] as const;
const SPEED_WINDOW_MS = 10_000;

export type UploadPhase = 'idle' | 'uploading' | 'paused' | 'completing' | 'done' | 'failed' | 'cancelled';

export type UploadSnapshot = {
  phase: UploadPhase;
  sentBytes: number;
  totalBytes: number;
  /** 0–100, làm tròn xuống */
  percent: number;
  /** trung bình 10 giây gần nhất; null khi chưa đủ dữ liệu */
  bytesPerSecond: number | null;
  remainingMs: number | null;
  /** mã và thông báo của máy chủ (đã theo ngôn ngữ người dùng); null khi do mạng */
  error: { code: string; message: string | null } | null;
  needsLogin: boolean;
};

export type PartResponse = { status: number; code?: string; message?: string; retryAfterMs?: number };

export type PartTransport = (request: {
  url: string;
  body: Blob;
  sha256: string;
  signal: AbortSignal;
  onProgress: (loadedBytes: number) => void;
}) => Promise<PartResponse>;

export type CompleteTransport = (uploadId: string, signal: AbortSignal) => Promise<PartResponse & { missingParts?: number[] }>;

export type UploadOptions = {
  uploadId: string;
  file: Blob;
  partSize: number;
  partCount: number;
  /** các phần máy chủ đã nhận (tải tiếp) */
  received?: readonly number[];
  transport?: PartTransport;
  complete?: CompleteTransport;
  hash?: (part: Blob) => Promise<string>;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
};

export async function sha256Hex(part: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await part.arrayBuffer());
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

function errorBody(text: string): { code?: string; message?: string; fields?: Record<string, string> } {
  try {
    return (JSON.parse(text) as { error?: { code?: string; message?: string; fields?: Record<string, string> } }).error ?? {};
  } catch {
    return {};
  }
}

/** Gửi một phần bằng XMLHttpRequest; lỗi mạng trả `status = 0`. */
export const xhrTransport: PartTransport = ({ url, body, sha256, signal, onProgress }) =>
  new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException('aborted', 'AbortError'));
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    const done = (r: PartResponse) => {
      signal.removeEventListener('abort', abort);
      resolve(r);
    };
    xhr.open('PUT', url);
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    xhr.setRequestHeader('x-part-sha256', sha256);
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => {
      const e = xhr.status >= 400 ? errorBody(xhr.responseText) : {};
      const after = Number(xhr.getResponseHeader('retry-after'));
      done({ status: xhr.status, code: e.code, message: e.message, retryAfterMs: Number.isFinite(after) && after > 0 ? after * 1000 : undefined });
    };
    xhr.onerror = () => done({ status: 0 });
    xhr.ontimeout = () => done({ status: 0 });
    xhr.onabort = () => {
      signal.removeEventListener('abort', abort);
      reject(new DOMException('aborted', 'AbortError'));
    };
    signal.addEventListener('abort', abort, { once: true });
    xhr.send(body);
  });

export const fetchComplete: CompleteTransport = async (uploadId, signal) => {
  let res: Response;
  try {
    res = await fetch(`/api/video/uploads/${uploadId}/complete`, { method: 'POST', credentials: 'same-origin', signal });
  } catch (e) {
    if (signal.aborted) throw e;
    return { status: 0 };
  }
  if (res.ok) return { status: res.status };
  const e = errorBody(await res.text().catch(() => ''));
  return { status: res.status, code: e.code, message: e.message, missingParts: e.fields?.missingParts?.split(',').map(Number).filter(Number.isInteger) };
};

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new DOMException('aborted', 'AbortError'));
      },
      { once: true },
    );
  });
}

type Outcome = 'ok' | 'paused' | 'failed';

export class VideoUpload {
  private readonly o: Required<Omit<UploadOptions, 'received'>>;
  private readonly done: Set<number>;
  private readonly inFlight = new Map<number, number>();
  private samples: Array<{ at: number; bytes: number }> = [];
  private controller: AbortController | null = null;
  private listeners = new Set<() => void>();
  private snapshot: UploadSnapshot;
  /** kết thúc của lượt chạy hiện tại (dùng trong kiểm thử) */
  running: Promise<void> = Promise.resolve();

  constructor(options: UploadOptions) {
    this.o = {
      transport: xhrTransport,
      complete: fetchComplete,
      hash: sha256Hex,
      sleep: defaultSleep,
      now: () => Date.now(),
      ...options,
    };
    this.done = new Set(options.received ?? []);
    this.snapshot = this.build('idle');
  }

  get uploadId(): string {
    return this.o.uploadId;
  }

  getSnapshot = (): UploadSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  start(): void {
    if (this.snapshot.phase !== 'idle' && this.snapshot.phase !== 'paused') return;
    this.controller = new AbortController();
    this.samples = [];
    this.publish('uploading');
    this.running = this.run(this.controller);
  }

  resume(): void {
    this.start();
  }

  pause(): void {
    if (this.snapshot.phase !== 'uploading' && this.snapshot.phase !== 'completing') return;
    this.controller?.abort();
    this.inFlight.clear();
    this.publish('paused');
  }

  /** Dừng gửi; việc hủy phiên ở máy chủ do người gọi thực hiện. */
  cancel(): void {
    this.controller?.abort();
    this.inFlight.clear();
    this.publish('cancelled');
  }

  private sizeOf(n: number): number {
    return n < this.o.partCount ? this.o.partSize : this.o.file.size - this.o.partSize * (this.o.partCount - 1);
  }

  private sent(): number {
    let total = 0;
    for (const n of this.done) total += this.sizeOf(n);
    for (const loaded of this.inFlight.values()) total += loaded;
    return Math.min(total, this.o.file.size);
  }

  private build(phase: UploadPhase, error: UploadSnapshot['error'] = null, needsLogin = false): UploadSnapshot {
    const sentBytes = this.sent();
    const totalBytes = this.o.file.size;
    let bytesPerSecond: number | null = null;
    const first = this.samples[0];
    const last = this.samples.at(-1);
    if (phase === 'uploading' && first && last && last.at - first.at >= 500) bytesPerSecond = Math.max(0, ((last.bytes - first.bytes) * 1000) / (last.at - first.at));
    const percent = phase === 'done' ? 100 : Math.floor((sentBytes / Math.max(1, totalBytes)) * 100);
    const remainingMs = bytesPerSecond && bytesPerSecond > 0 ? Math.round(((totalBytes - sentBytes) / bytesPerSecond) * 1000) : null;
    return { phase, sentBytes, totalBytes, percent, bytesPerSecond, remainingMs, error, needsLogin };
  }

  private publish(phase: UploadPhase, error: UploadSnapshot['error'] = null, needsLogin = false): void {
    this.snapshot = this.build(phase, error, needsLogin);
    for (const l of this.listeners) l();
  }

  private sample(): void {
    const at = this.o.now();
    this.samples.push({ at, bytes: this.sent() });
    while (this.samples.length > 2 && at - this.samples[0]!.at > SPEED_WINDOW_MS) this.samples.shift();
  }

  /** Dừng cả lượt vì một lỗi: tạm dừng (thử lại được) hoặc hỏng hẳn. */
  private halt(controller: AbortController, phase: 'paused' | 'failed', response: PartResponse): Outcome {
    if (controller.signal.aborted) return 'paused';
    controller.abort();
    this.inFlight.clear();
    const needsLogin = response.status === 401;
    // phản hồi không có mã (ví dụ từ máy chủ trung gian): hỏng hẳn thì không được bảo người dùng bấm "Tiếp tục"
    const code = response.code ?? (phase === 'failed' ? 'UNEXPECTED' : 'NETWORK');
    this.publish(phase, { code, message: response.code ? (response.message ?? null) : null }, needsLogin);
    return phase;
  }

  /** Thực hiện một yêu cầu với chính sách thử lại chung. Trả `ok` hoặc dừng cả lượt. */
  private async attempt(controller: AbortController, request: () => Promise<PartResponse>): Promise<{ outcome: Outcome; response: PartResponse }> {
    for (let tries = 0; ; tries++) {
      const response = await request();
      if (response.status >= 200 && response.status < 300) return { outcome: 'ok', response };
      if (response.status === 401) return { outcome: this.halt(controller, 'paused', response), response };
      // 422 là phần bị hỏng trên đường truyền: gửi lại như lỗi tạm
      const transient = response.status === 0 || response.status === 408 || response.status === 422 || response.status === 429 || response.status >= 500;
      if (!transient) {
        if (response.code === 'UPLOAD_INCOMPLETE') return { outcome: 'ok', response };
        return { outcome: this.halt(controller, 'failed', response), response };
      }
      if (tries >= RETRY_DELAYS_MS.length) return { outcome: this.halt(controller, 'paused', response), response };
      await this.o.sleep(Math.max(RETRY_DELAYS_MS[tries]!, response.retryAfterMs ?? 0), controller.signal);
    }
  }

  private async sendPart(controller: AbortController, n: number): Promise<Outcome> {
    const start = (n - 1) * this.o.partSize;
    const body = this.o.file.slice(start, start + this.sizeOf(n));
    const sha256 = await this.o.hash(body);
    const { outcome } = await this.attempt(controller, async () => {
      this.inFlight.set(n, 0);
      return this.o.transport({
        url: `/api/video/uploads/${this.o.uploadId}/parts/${n}`,
        body,
        sha256,
        signal: controller.signal,
        onProgress: (loaded) => {
          if (controller.signal.aborted) return;
          this.inFlight.set(n, Math.min(loaded, body.size));
          this.sample();
          this.publish('uploading');
        },
      });
    });
    this.inFlight.delete(n);
    if (outcome === 'ok') {
      this.done.add(n);
      this.sample();
      // lượt đã bị dừng trong lúc phần này về đích: ghi nhận phần đã xong nhưng không đổi trạng thái
      if (controller.signal.aborted) this.publish(this.snapshot.phase, this.snapshot.error, this.snapshot.needsLogin);
      else this.publish('uploading');
    }
    return outcome;
  }

  private async sendMissing(controller: AbortController): Promise<boolean> {
    const queue = Array.from({ length: this.o.partCount }, (_, i) => i + 1).filter((n) => !this.done.has(n));
    this.sample();
    const worker = async () => {
      for (let n = queue.shift(); n !== undefined; n = queue.shift()) {
        if (controller.signal.aborted || (await this.sendPart(controller, n)) !== 'ok') return;
      }
    };
    await Promise.all(Array.from({ length: Math.min(UPLOAD_PARALLEL, queue.length) }, worker));
    return !controller.signal.aborted;
  }

  private async run(controller: AbortController): Promise<void> {
    try {
      // một lần gửi bù nếu máy chủ báo còn thiếu phần
      for (let round = 0; round < 2; round++) {
        if (!(await this.sendMissing(controller))) return;
        this.publish('completing');
        let missing: number[] = [];
        const { outcome, response } = await this.attempt(controller, async () => {
          const r = await this.o.complete(this.o.uploadId, controller.signal);
          missing = r.missingParts ?? [];
          return r;
        });
        if (outcome !== 'ok') return;
        if (response.status < 300) {
          this.publish('done');
          return;
        }
        if (round === 1 || missing.length === 0) {
          this.halt(controller, 'failed', response);
          return;
        }
        for (const n of missing) this.done.delete(n);
        this.publish('uploading');
      }
    } catch (e) {
      if (controller.signal.aborted) return; // tạm dừng hoặc hủy
      this.halt(controller, 'paused', { status: 0, message: e instanceof Error ? e.message : undefined });
    }
  }
}

// ---- Các lượt tải đang sống trong tab trình duyệt -----------------------------------------------

/** Tệp trên máy của các video đã chọn trong phiên này: trình biên tập phát thẳng từ tệp, không phải tải lại từ máy chủ. */
const localFiles = new Map<string, { file: Blob; url: string | null }>();
export const rememberLocalVideo = (jobId: string, file: Blob): void => {
  forgetLocalVideo(jobId);
  localFiles.set(jobId, { file, url: null });
};
/** Địa chỉ phát của tệp trên máy, tạo một lần rồi dùng lại. */
export function localVideoUrl(jobId: string): string | null {
  const hit = localFiles.get(jobId);
  return hit ? (hit.url ??= URL.createObjectURL(hit.file)) : null;
}
export function forgetLocalVideo(jobId: string): void {
  const url = localFiles.get(jobId)?.url;
  if (url) URL.revokeObjectURL(url);
  localFiles.delete(jobId);
}

const live = new Map<string, VideoUpload>();
const watchers = new Set<() => void>();
let version = 0;
const bump = () => {
  version++;
  for (const w of watchers) w();
};

/** Giữ lượt tải theo id việc để chuyển tab hay trang trong ứng dụng không làm đứt việc tải. */
export const uploadRegistry = {
  get: (jobId: string): VideoUpload | undefined => live.get(jobId),
  add(jobId: string, upload: VideoUpload): VideoUpload {
    live.get(jobId)?.cancel();
    live.set(jobId, upload);
    upload.subscribe(bump);
    bump();
    return upload;
  },
  remove(jobId: string): void {
    live.get(jobId)?.cancel();
    live.delete(jobId);
    bump();
  },
  subscribe(listener: () => void): () => void {
    watchers.add(listener);
    return () => watchers.delete(listener);
  },
  /** đổi mỗi khi có lượt tải thay đổi (cho useSyncExternalStore) */
  version: (): number => version,
  /** còn lượt tải chưa xong và chưa hỏng: rời trang sẽ mất */
  busy: (): boolean => [...live.values()].some((u) => !['done', 'failed', 'cancelled'].includes(u.getSnapshot().phase)),
};

// hết phiên giữa lúc tải thì tạm dừng và chờ đăng nhập lại ở thẻ khác, không chuyển trang
holdLoginRedirect(uploadRegistry.busy);
