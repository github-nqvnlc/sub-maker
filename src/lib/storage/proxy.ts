import { getObjectRange, headObject } from './client';

/**
 * Phát file từ MinIO qua proxy xác thực, hỗ trợ `Range` để tua (R5, FR-026).
 * Chỉ hỗ trợ một dải `bytes=start-end` / `bytes=start-` / `bytes=-suffix`.
 */

export type ParsedRange = { start: number; end: number } | 'unsatisfiable' | null;

export function parseRange(header: string | null | undefined, size: number): ParsedRange {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null; // không hiểu → bỏ qua, trả toàn bộ
  const [, a, b] = m;
  if (a === '' && b === '') return null;
  let start: number;
  let end: number;
  if (a === '') {
    // suffix: n byte cuối
    const n = Number(b);
    if (n === 0) return 'unsatisfiable';
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(a);
    end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return 'unsatisfiable';
  return { start, end };
}

export type ServeOptions = {
  contentType: string;
  /** Có giá trị → trả kèm Content-Disposition: attachment (FR-029) */
  downloadName?: string;
  rangeHeader?: string | null;
  cacheControl?: string;
  /** trình duyệt ngắt thì hủy luôn lệnh đọc kho */
  signal?: AbortSignal;
  /** Dải mở (`bytes=N-`) chỉ trả tối đa từng này byte; trình duyệt tự hỏi tiếp (video lớn, spec 006). */
  maxOpenRange?: number;
  /** Gọi khi bắt đầu phát rồi mỗi 60 giây trong lúc luồng còn chạy: gia hạn thẻ giữ lượt tải (spec 006). */
  onStreaming?: () => Promise<unknown>;
};

export const LEASE_RENEW_MS = 60_000;

/** Bọc luồng để biết khi nào nó kết thúc (xong, hủy hoặc lỗi) và giữ nhịp gia hạn trong khoảng đó. */
function leased(source: ReadableStream<Uint8Array>, beat: () => Promise<unknown>, signal?: AbortSignal): ReadableStream<Uint8Array> {
  const run = () => void beat().catch(() => undefined);
  run();
  const timer = setInterval(run, LEASE_RENEW_MS);
  (timer as { unref?: () => void }).unref?.();
  const stop = () => clearInterval(timer);
  signal?.addEventListener('abort', stop, { once: true });
  const reader = source.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          stop();
          controller.close();
        } else controller.enqueue(value);
      } catch (e) {
        stop();
        controller.error(e);
      }
    },
    async cancel(reason) {
      stop();
      await reader.cancel(reason).catch(() => undefined);
    },
  });
}

function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** Trả Response (200/206/416/404) cho một khóa đối tượng. Việc kiểm tra quyền phải làm TRƯỚC khi gọi. */
export async function serveObject(key: string, opts: ServeOptions): Promise<Response> {
  const head = await headObject(key);
  if (!head) return new Response(null, { status: 404 });
  const size = head.size;

  const baseHeaders: Record<string, string> = {
    'content-type': opts.contentType,
    'accept-ranges': 'bytes',
    'cache-control': opts.cacheControl ?? 'private, no-store',
    'x-content-type-options': 'nosniff',
  };
  if (opts.downloadName) baseHeaders['content-disposition'] = contentDisposition(opts.downloadName);

  const range = parseRange(opts.rangeHeader, size);
  if (range === 'unsatisfiable') {
    return new Response(null, { status: 416, headers: { ...baseHeaders, 'content-range': `bytes */${size}` } });
  }

  const body = async (header?: string) => {
    const res = await getObjectRange(key, header, opts.signal);
    const stream = res.Body!.transformToWebStream() as ReadableStream<Uint8Array>;
    return opts.onStreaming ? leased(stream, opts.onStreaming, opts.signal) : stream;
  };

  if (range) {
    const open = /^bytes=\d+-$/.test(opts.rangeHeader!.trim());
    const end = open && opts.maxOpenRange ? Math.min(range.end, range.start + opts.maxOpenRange - 1) : range.end;
    return new Response(await body(`bytes=${range.start}-${end}`), {
      status: 206,
      headers: {
        ...baseHeaders,
        'content-range': `bytes ${range.start}-${end}/${size}`,
        'content-length': String(end - range.start + 1),
      },
    });
  }

  return new Response(await body(), {
    status: 200,
    headers: { ...baseHeaders, 'content-length': String(size) },
  });
}
