/**
 * Nhận diện đúng tệp video khi tải tiếp và tải lại (spec 006, research R7): dung lượng cùng ba đoạn 1 MB ở đầu, giữa và cuối.
 * Chạy được ở trình duyệt và máy chủ (Web Crypto); tệp lớn tới đâu cũng chỉ đọc 3 MB.
 */
export const FINGERPRINT_SPAN = 1024 * 1024;

/** Ba đoạn `[start, end)` cần đọc; tệp nhỏ thì các đoạn chồng nhau. */
export function fingerprintRanges(size: number): Array<[number, number]> {
  const span = Math.min(FINGERPRINT_SPAN, size);
  const middle = Math.max(0, Math.floor(size / 2 - span / 2));
  return [
    [0, span],
    [middle, middle + span],
    [size - span, size],
  ];
}

export async function fingerprintOf(size: number, read: (start: number, end: number) => Promise<Uint8Array>): Promise<string> {
  const head = new TextEncoder().encode(`${size}:`);
  const parts: Uint8Array[] = [head];
  for (const [start, end] of fingerprintRanges(size)) parts.push(await read(start, end));
  const joined = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    joined.set(p, at);
    at += p.length;
  }
  const digest = await crypto.subtle.digest('SHA-256', joined);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Nhận diện một `File`/`Blob` của trình duyệt. */
export const fingerprintFile = (file: Blob): Promise<string> => fingerprintOf(file.size, async (start, end) => new Uint8Array(await file.slice(start, end).arrayBuffer()));
