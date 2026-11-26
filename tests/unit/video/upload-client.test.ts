import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { RETRY_DELAYS_MS, sha256Hex, UPLOAD_PARALLEL, uploadRegistry, VideoUpload, type PartResponse, type UploadOptions, type UploadSnapshot } from '@/lib/video/upload-client';

/** Bộ tải video ở trình duyệt (spec 006, T046; contracts/render-and-media.md §5). */

const PART = 100;
const file = (size: number) => new Blob([new Uint8Array(size).map((_, i) => i % 251)]);

type Call = { n: number; sha256: string; size: number; resolve: (r: PartResponse) => void; progress: (n: number) => void; signal: AbortSignal };

/** Đường truyền giả: mỗi phần đứng chờ tới khi kiểm thử trả lời, hoặc trả lời theo kịch bản. */
function harness(over: Partial<UploadOptions> & { size?: number; script?: (n: number, tries: number) => PartResponse | null } = {}) {
  const { size = 5 * PART, script, ...options } = over;
  const calls: Call[] = [];
  const slept: number[] = [];
  const completed: string[] = [];
  const tries = new Map<number, number>();
  let clock = 0;
  const upload = new VideoUpload({
    uploadId: 'u1',
    file: file(size),
    partSize: PART,
    partCount: Math.ceil(size / PART),
    now: () => clock,
    sleep: async (ms, signal) => {
      signal.throwIfAborted();
      slept.push(ms);
    },
    transport: ({ url, body, sha256, signal, onProgress }) =>
      new Promise((resolve, reject) => {
        const n = Number(url.split('/').at(-1));
        const t = (tries.get(n) ?? 0) + 1;
        tries.set(n, t);
        signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
        calls.push({ n, sha256, size: body.size, resolve, progress: onProgress, signal });
        const auto = script?.(n, t);
        if (auto) queueMicrotask(() => resolve(auto));
      }),
    complete: async (id) => {
      completed.push(id);
      return { status: 200 };
    },
    // băm giả xong ngay nên thứ tự gửi cố định; băm thật được kiểm riêng
    hash: async () => 'a'.repeat(64),
    ...options,
  });
  return { upload, calls, slept, completed, tick: (ms: number) => (clock += ms) };
}

const ok: PartResponse = { status: 204 };
const settle = () => new Promise((r) => setTimeout(r, 5));
const phase = (u: VideoUpload): UploadSnapshot['phase'] => u.getSnapshot().phase;

describe('gửi phần', () => {
  it('tối đa ba phần cùng lúc rồi ghép đúng một lần', async () => {
    const h = harness({ size: 5 * PART - 30 });
    expect(phase(h.upload)).toBe('idle');
    h.upload.start();
    await settle();
    expect(h.calls.map((c) => c.n)).toEqual([1, 2, 3]);
    expect(h.calls).toHaveLength(UPLOAD_PARALLEL);
    h.calls[1]!.resolve(ok);
    await settle();
    expect(h.calls.map((c) => c.n)).toEqual([1, 2, 3, 4]);
    for (const c of [0, 2, 3]) h.calls[c]!.resolve(ok);
    await settle();
    h.calls[4]!.resolve(ok);
    await h.upload.running;
    expect(h.calls.map((c) => c.size)).toEqual([100, 100, 100, 100, 70]);
    expect(h.completed).toEqual(['u1']);
    expect(h.upload.getSnapshot()).toMatchObject({ phase: 'done', percent: 100, sentBytes: 470, error: null });
  });

  it('mỗi phần gửi kèm mã băm của đúng đoạn tệp đó', async () => {
    const h = harness({ size: 3 * PART - 30, hash: sha256Hex, script: () => ok });
    h.upload.start();
    await h.upload.running;
    for (const c of h.calls) {
      const slice = Buffer.from(await file(270).slice((c.n - 1) * PART, c.n * PART).arrayBuffer());
      expect(c.sha256).toBe(createHash('sha256').update(slice).digest('hex'));
    }
    expect(h.calls).toHaveLength(3);
  });

  it('tải tiếp: bỏ qua phần máy chủ đã nhận và tính chúng vào phần trăm', async () => {
    const h = harness({ received: [1, 2, 4], script: () => ok });
    expect(h.upload.getSnapshot()).toMatchObject({ sentBytes: 300, percent: 60 });
    h.upload.start();
    await h.upload.running;
    expect(h.calls.map((c) => c.n).sort()).toEqual([3, 5]);
    expect(phase(h.upload)).toBe('done');
  });

  it('tốc độ trung bình 10 giây gần nhất và thời gian còn lại', async () => {
    const h = harness({ size: 1000, partSize: 1000, partCount: 1 });
    h.upload.start();
    await settle();
    for (let i = 1; i <= 5; i++) {
      h.tick(1000);
      h.calls[0]!.progress(i * 100);
    }
    expect(h.upload.getSnapshot()).toMatchObject({ sentBytes: 500, percent: 50, bytesPerSecond: 100, remainingMs: 5000 });
    // nhanh hẳn lên trong 10 giây sau: cửa sổ cũ bị bỏ
    for (let i = 1; i <= 11; i++) {
      h.tick(1000);
      h.calls[0]!.progress(500 + i * 40);
    }
    expect(h.upload.getSnapshot().bytesPerSecond).toBeCloseTo(40, 0);
  });
});

describe('lỗi và thử lại', () => {
  it.each([
    ['mạng', { status: 0 }],
    ['429', { status: 429, code: 'UPLOAD_BUSY' }],
    ['503', { status: 503 }],
    ['phần hỏng', { status: 422, code: 'UPLOAD_PART_CHECKSUM' }],
  ])('lỗi %s: thử lại 1, 2, 4, 8, 16 giây rồi tạm dừng', async (_n, failure) => {
    const h = harness({ size: PART, script: () => failure });
    h.upload.start();
    await h.upload.running;
    expect(h.slept).toEqual([...RETRY_DELAYS_MS]);
    expect(h.calls).toHaveLength(6);
    expect(h.upload.getSnapshot()).toMatchObject({ phase: 'paused', needsLogin: false });
  });

  it('thử lại thành công thì đi tiếp; tôn trọng Retry-After dài hơn', async () => {
    const h = harness({ size: PART, script: (_n, t) => (t === 1 ? { status: 429, retryAfterMs: 5000 } : ok) });
    h.upload.start();
    await h.upload.running;
    expect(h.slept).toEqual([5000]);
    expect(phase(h.upload)).toBe('done');
  });

  it('tạm dừng sau lỗi rồi tiếp tục: chỉ gửi phần chưa xong', async () => {
    let broken = true;
    const h = harness({ script: (n) => (n === 4 && broken ? { status: 0 } : ok) });
    h.upload.start();
    await h.upload.running;
    expect(phase(h.upload)).toBe('paused');
    broken = false;
    const before = h.calls.length;
    h.upload.resume();
    await h.upload.running;
    expect(phase(h.upload)).toBe('done');
    expect(h.calls.slice(before).map((c) => c.n)).toContain(4);
    expect(h.calls.slice(before).map((c) => c.n)).not.toContain(1);
  });

  it('401: tạm dừng và yêu cầu đăng nhập', async () => {
    const h = harness({ script: () => ({ status: 401, code: 'UNAUTHENTICATED', message: 'Bạn cần đăng nhập' }) });
    h.upload.start();
    await h.upload.running;
    expect(h.upload.getSnapshot()).toMatchObject({ phase: 'paused', needsLogin: true, error: { code: 'UNAUTHENTICATED' } });
    expect(h.slept).toEqual([]);
  });

  it.each([403, 404, 409])('%d: dừng hẳn và báo đúng thông báo của máy chủ', async (status) => {
    const h = harness({ script: () => ({ status, code: 'UPLOAD_CLOSED', message: 'Phiên đã đóng' }) });
    h.upload.start();
    await h.upload.running;
    expect(h.upload.getSnapshot()).toMatchObject({ phase: 'failed', error: { code: 'UPLOAD_CLOSED', message: 'Phiên đã đóng' } });
    expect(h.slept).toEqual([]);
    h.upload.resume();
    expect(phase(h.upload)).toBe('failed');
  });

  it('máy chủ báo thiếu phần khi ghép: gửi bù rồi ghép lại; thiếu mãi thì báo lỗi', async () => {
    let times = 0;
    const h = harness({ script: () => ok, complete: async () => (++times === 1 ? { status: 409, code: 'UPLOAD_INCOMPLETE', missingParts: [2] } : { status: 200 }) });
    h.upload.start();
    await h.upload.running;
    expect(h.calls.filter((c) => c.n === 2)).toHaveLength(2);
    expect(phase(h.upload)).toBe('done');

    const always = harness({ script: () => ok, complete: async () => ({ status: 409, code: 'UPLOAD_INCOMPLETE', missingParts: [1] }) });
    always.upload.start();
    await always.upload.running;
    expect(phase(always.upload)).toBe('failed');
  });
});

describe('tạm dừng và hủy', () => {
  it('tạm dừng hủy yêu cầu đang bay; tiếp tục gửi lại đúng các phần đó', async () => {
    const h = harness({});
    h.upload.start();
    await settle();
    h.calls[0]!.resolve(ok);
    await settle();
    h.upload.pause();
    expect(h.calls.slice(1).every((c) => c.signal.aborted)).toBe(true);
    expect(h.upload.getSnapshot()).toMatchObject({ phase: 'paused', sentBytes: 100, bytesPerSecond: null });
    await h.upload.running;
    const before = h.calls.length;
    h.upload.resume();
    await settle();
    expect(h.calls.slice(before).map((c) => c.n)).toEqual([2, 3, 4]);
    h.upload.cancel();
    await h.upload.running;
    expect(phase(h.upload)).toBe('cancelled');
    expect(h.completed).toEqual([]);
  });

  it('sổ lượt tải giữ một lượt cho mỗi việc và hủy lượt cũ', () => {
    const a = harness({}).upload;
    const b = harness({}).upload;
    let changes = 0;
    const off = uploadRegistry.subscribe(() => changes++);
    uploadRegistry.add('job', a);
    uploadRegistry.add('job', b);
    expect(phase(a)).toBe('cancelled');
    expect(uploadRegistry.get('job')).toBe(b);
    uploadRegistry.remove('job');
    expect(uploadRegistry.get('job')).toBeUndefined();
    expect(changes).toBeGreaterThanOrEqual(3);
    off();
  });

  it('mã băm phần tính bằng Web Crypto trùng SHA-256', async () => {
    expect(await sha256Hex(new Blob(['abc']))).toBe(createHash('sha256').update('abc').digest('hex'));
  });
});
