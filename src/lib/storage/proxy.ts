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
  signal?: AbortSignal;
};

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

  if (range) {
    const res = await getObjectRange(key, `bytes=${range.start}-${range.end}`);
    const stream = res.Body!.transformToWebStream();
    return new Response(stream, {
      status: 206,
      headers: {
        ...baseHeaders,
        'content-range': `bytes ${range.start}-${range.end}/${size}`,
        'content-length': String(range.end - range.start + 1),
      },
    });
  }

  const res = await getObjectRange(key);
  return new Response(res.Body!.transformToWebStream(), {
    status: 200,
    headers: { ...baseHeaders, 'content-length': String(size) },
  });
}
