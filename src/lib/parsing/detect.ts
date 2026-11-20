export type ScriptExt = 'txt' | 'md' | 'srt';

export type ScriptErrorCode = 'UNSUPPORTED_TYPE' | 'TOO_LARGE' | 'INVALID_ENCODING' | 'BINARY' | 'EMPTY';

/** Lỗi kiểm tra/phân tích kịch bản; `message` là tiếng Việt, nêu nguyên nhân và cách xử lý (SC-010). */
export class ScriptError extends Error {
  constructor(
    public readonly code: ScriptErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ScriptError';
  }
}

const EXTS: readonly ScriptExt[] = ['txt', 'md', 'srt'];

export function extOf(fileName: string): ScriptExt | null {
  const m = /\.([A-Za-z0-9]+)$/.exec(fileName.trim());
  const ext = m?.[1]?.toLowerCase();
  return EXTS.find((e) => e === ext) ?? null;
}

/**
 * Giải mã UTF-8 nghiêm ngặt (bỏ BOM). Từ chối UTF-16, byte lạ và dữ liệu nhị phân
 * để không gửi rác cho nhà cung cấp (FR-009).
 */
export function decodeUtf8(buf: Uint8Array): string {
  // UTF-16 LE/BE BOM
  if (buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff))) {
    throw new ScriptError('INVALID_ENCODING', 'Tệp không phải mã hóa UTF-8 (có vẻ là UTF-16). Hãy lưu lại tệp ở dạng UTF-8 rồi tải lên.');
  }
  // Byte NUL gần như chắc chắn là tệp nhị phân (PDF, ảnh, Office…)
  const sample = buf.subarray(0, Math.min(buf.length, 8192));
  if (sample.includes(0)) {
    throw new ScriptError('BINARY', 'Tệp có vẻ là dữ liệu nhị phân, không phải văn bản. Chỉ hỗ trợ tệp văn bản .txt, .md hoặc .srt.');
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    throw new ScriptError('INVALID_ENCODING', 'Tệp không phải mã hóa UTF-8 hợp lệ. Hãy lưu lại tệp ở dạng UTF-8 rồi tải lên.');
  }
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function validateScript(
  fileName: string,
  buf: Uint8Array,
  maxBytes: number,
): { ext: ScriptExt; text: string } {
  const ext = extOf(fileName);
  if (!ext) throw new ScriptError('UNSUPPORTED_TYPE', 'Định dạng không được hỗ trợ. Chỉ nhận tệp .txt, .md hoặc .srt.');
  if (buf.length === 0) throw new ScriptError('EMPTY', 'Tệp rỗng.');
  if (buf.length > maxBytes) {
    throw new ScriptError('TOO_LARGE', `Tệp lớn hơn ${(maxBytes / (1024 * 1024)).toFixed(maxBytes % (1024 * 1024) === 0 ? 0 : 1)} MB cho phép.`);
  }
  return { ext, text: decodeUtf8(buf) };
}
