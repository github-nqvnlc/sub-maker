import { ProviderError, classifyHttpError, toProviderError } from '../errors';
import type { CallContext } from '../types';

export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

/** Ngủ có thể hủy bằng AbortSignal. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function abortError(): Error {
  const e = new Error('aborted');
  e.name = 'AbortError';
  return e;
}

/** Có vẻ là dữ liệu audio (WAV/MP3/OGG/FLAC/AAC) chứ không phải JSON/HTML lỗi. */
export function looksLikeAudio(b: Uint8Array): boolean {
  if (b.length < 16) return false;
  const ascii = (o: number, n: number) => Buffer.from(b.subarray(o, o + n)).toString('latin1');
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WAVE') return true;
  if (ascii(0, 3) === 'ID3') return true;
  if (b[0] === 0xff && (b[1]! & 0xe0) === 0xe0) return true; // khung MP3/AAC
  if (ascii(0, 4) === 'OggS' || ascii(0, 4) === 'fLaC') return true;
  return false;
}

export function mimeFor(b: Uint8Array, headerType: string | null, fallback: string): string {
  const t = headerType?.split(';')[0]?.trim().toLowerCase();
  if (t && t.startsWith('audio/')) return t;
  const ascii = Buffer.from(b.subarray(0, 4)).toString('latin1');
  if (ascii === 'RIFF') return 'audio/wav';
  if (ascii.startsWith('ID3') || (b[0] === 0xff && (b[1]! & 0xe0) === 0xe0)) return 'audio/mpeg';
  return fallback;
}

/** Gọi qua safeFetch và chuyển mọi lỗi thành ProviderError (không lộ chi tiết). */
export async function callOk(
  ctx: CallContext,
  url: string,
  init: RequestInit,
): Promise<Response> {
  let res: Response;
  try {
    res = await ctx.fetch(url, { ...init, signal: ctx.signal });
  } catch (e) {
    if (ctx.signal?.aborted) throw e; // hủy: để worker xử lý như dừng
    throw toProviderError(e);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw classifyHttpError(res.status, body, res.headers.get('retry-after'));
  }
  return res;
}

export async function readAudio(res: Response, fallbackMime: string): Promise<{ audio: Uint8Array; mime: string }> {
  const audio = new Uint8Array(await res.arrayBuffer());
  if (!looksLikeAudio(audio)) {
    // Phản hồi 200 nhưng không phải audio (JSON lỗi, HTML…): coi là lỗi tạm thời của nhà cung cấp
    throw new ProviderError('transient');
  }
  return { audio, mime: mimeFor(audio, res.headers.get('content-type'), fallbackMime) };
}

export const charCount = (text: string) => [...text].length;
