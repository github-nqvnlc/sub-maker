import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import type { LookupFunction } from 'node:net';

/**
 * Lớp gọi ra ngoài chống SSRF (research R9, Nguyên tắc II).
 * - Chỉ `https` (cho `http` khi `allowInsecure`).
 * - Phân giải DNS rồi từ chối địa chỉ nội bộ; **ghim** địa chỉ đã kiểm tra khi kết nối (chống DNS rebinding).
 * - Không theo chuyển hướng.
 * - Giới hạn kích thước và thời gian phản hồi.
 * `allowInsecure` (chỉ dev/kiểm thử) cho phép http và địa chỉ loopback/riêng tư;
 * địa chỉ link-local (169.254.0.0/16, fe80::/10, gồm cả metadata đám mây) LUÔN bị chặn.
 */

export class SsrfError extends Error {
  constructor(
    public readonly code:
      | 'SCHEME_NOT_ALLOWED'
      | 'HOST_NOT_ALLOWED'
      | 'ADDRESS_NOT_ALLOWED'
      | 'REDIRECT_BLOCKED'
      | 'RESPONSE_TOO_LARGE'
      | 'TIMEOUT'
      | 'INVALID_URL',
    message: string,
  ) {
    super(message);
    this.name = 'SsrfError';
  }
}

export type SafeFetchOptions = {
  /** Dev/kiểm thử: cho phép http và loopback/riêng tư (KHÔNG cho link-local). */
  allowInsecure?: boolean;
  /** Mặc định 64 MB. */
  maxBytes?: number;
  /** Mặc định 120 giây. */
  timeoutMs?: number;
  /** Cho kiểm thử: thay thế phân giải DNS. */
  lookup?: (hostname: string) => Promise<string[]>;
};

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;

/** Luôn chặn, kể cả khi allowInsecure. */
const alwaysBlocked = new net.BlockList();
alwaysBlocked.addSubnet('169.254.0.0', 16, 'ipv4');
alwaysBlocked.addSubnet('0.0.0.0', 8, 'ipv4');
alwaysBlocked.addSubnet('224.0.0.0', 4, 'ipv4');
alwaysBlocked.addSubnet('240.0.0.0', 4, 'ipv4');
alwaysBlocked.addSubnet('fe80::', 10, 'ipv6');
alwaysBlocked.addSubnet('ff00::', 8, 'ipv6');
alwaysBlocked.addAddress('::', 'ipv6');

/** Chặn trừ khi allowInsecure. */
const privateRanges = new net.BlockList();
privateRanges.addSubnet('127.0.0.0', 8, 'ipv4');
privateRanges.addSubnet('10.0.0.0', 8, 'ipv4');
privateRanges.addSubnet('172.16.0.0', 12, 'ipv4');
privateRanges.addSubnet('192.168.0.0', 16, 'ipv4');
privateRanges.addSubnet('100.64.0.0', 10, 'ipv4'); // CGNAT
privateRanges.addSubnet('192.0.0.0', 24, 'ipv4');
privateRanges.addSubnet('198.18.0.0', 15, 'ipv4');
privateRanges.addAddress('::1', 'ipv6');
privateRanges.addSubnet('fc00::', 7, 'ipv6');

/** Đưa IPv4-mapped IPv6 (::ffff:a.b.c.d) về IPv4 để kiểm tra đúng luật. */
function normalizeIp(ip: string): { ip: string; family: 'ipv4' | 'ipv6' } {
  const lower = ip.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) return { ip: mapped[1]!, family: 'ipv4' };
  // dạng hex của mapped: ::ffff:7f00:1
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hex) {
    const hi = parseInt(hex[1]!, 16);
    const lo = parseInt(hex[2]!, 16);
    return { ip: `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`, family: 'ipv4' };
  }
  return { ip: lower, family: net.isIPv6(lower) ? 'ipv6' : 'ipv4' };
}

export function isForbiddenAddress(ip: string, opts: { allowInsecure?: boolean } = {}): boolean {
  const n = normalizeIp(ip);
  if (alwaysBlocked.check(n.ip, n.family)) return true;
  if (!opts.allowInsecure && privateRanges.check(n.ip, n.family)) return true;
  return false;
}

async function defaultLookup(hostname: string): Promise<string[]> {
  const results = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  return results.map((r) => r.address);
}

/** Kiểm tra URL và trả địa chỉ đã ghim. */
export async function resolveSafeTarget(
  rawUrl: string,
  opts: SafeFetchOptions = {},
): Promise<{ url: URL; address: string }> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfError('INVALID_URL', 'Địa chỉ không hợp lệ');
  }
  const allowInsecure = !!opts.allowInsecure;
  if (url.protocol !== 'https:' && !(allowInsecure && url.protocol === 'http:')) {
    throw new SsrfError('SCHEME_NOT_ALLOWED', 'Chỉ cho phép địa chỉ https');
  }
  if (url.username || url.password) {
    throw new SsrfError('HOST_NOT_ALLOWED', 'Địa chỉ không được chứa thông tin đăng nhập');
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const ipLiteral = net.isIP(hostname) ? hostname : null;

  let addresses: string[];
  if (ipLiteral) {
    addresses = [ipLiteral];
  } else {
    const lower = hostname.toLowerCase();
    // Tên nội bộ: không có dấu chấm (tên dịch vụ Docker), localhost, .local/.internal/.lan
    const internalName =
      !lower.includes('.') || lower === 'localhost' || /\.(local|internal|lan|localdomain|home\.arpa)$/.test(lower);
    if (internalName && !allowInsecure) {
      throw new SsrfError('HOST_NOT_ALLOWED', 'Tên máy chủ nội bộ không được phép');
    }
    try {
      addresses = await (opts.lookup ?? defaultLookup)(hostname);
    } catch {
      throw new SsrfError('HOST_NOT_ALLOWED', 'Không phân giải được tên máy chủ');
    }
  }
  if (addresses.length === 0) throw new SsrfError('HOST_NOT_ALLOWED', 'Không phân giải được tên máy chủ');

  // Chặn nếu BẤT KỲ địa chỉ nào bị cấm (tránh trả lẫn địa chỉ công khai và nội bộ)
  for (const a of addresses) {
    if (isForbiddenAddress(a, { allowInsecure })) {
      throw new SsrfError('ADDRESS_NOT_ALLOWED', 'Địa chỉ máy chủ không được phép');
    }
  }
  return { url, address: addresses[0]! };
}

function toHeaderRecord(h: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h) return out;
  new Headers(h).forEach((v, k) => {
    out[k] = v;
  });
  return out;
}

export type SafeFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** Tạo hàm fetch an toàn. Dùng cho mọi lệnh gọi nhà cung cấp và tải audio từ URL do nhà cung cấp trả về. */
export function createSafeFetch(opts: SafeFetchOptions = {}): SafeFetch {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return async (input, init = {}) => {
    const { url, address } = await resolveSafeTarget(String(input), opts);
    const lib = url.protocol === 'https:' ? https : http;

    // Ghim địa chỉ đã kiểm tra: kết nối luôn dùng `address`, không phân giải lại.
    const pinnedLookup: LookupFunction = (_host, options, cb) => {
      const family = net.isIPv6(address) ? 6 : 4;
      if ((options as { all?: boolean }).all) {
        (cb as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, [{ address, family }]);
      } else {
        cb(null, address, family);
      }
    };

    let body: Buffer | undefined;
    if (init.body != null) {
      if (typeof init.body === 'string') body = Buffer.from(init.body, 'utf8');
      else if (init.body instanceof Uint8Array) body = Buffer.from(init.body);
      else throw new TypeError('safeFetch chỉ hỗ trợ body dạng chuỗi hoặc byte');
    }
    const headers = toHeaderRecord(init.headers);
    if (body && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-length')) {
      headers['content-length'] = String(body.length);
    }

    return new Promise<Response>((resolve, reject) => {
      let settled = false;
      const fail = (err: unknown) => {
        if (settled) return;
        settled = true;
        reject(err);
      };

      const req = lib.request(
        url,
        {
          method: init.method ?? 'GET',
          headers,
          lookup: pinnedLookup,
          signal: init.signal ?? undefined,
        },
        (res) => {
          const status = res.statusCode ?? 0;
          if (status >= 300 && status < 400 && res.headers.location) {
            res.resume();
            return fail(new SsrfError('REDIRECT_BLOCKED', 'Không theo chuyển hướng từ nhà cung cấp'));
          }
          const declared = Number(res.headers['content-length']);
          if (Number.isFinite(declared) && declared > maxBytes) {
            res.destroy();
            return fail(new SsrfError('RESPONSE_TOO_LARGE', 'Phản hồi vượt quá kích thước cho phép'));
          }
          const chunks: Buffer[] = [];
          let total = 0;
          res.on('data', (c: Buffer) => {
            total += c.length;
            if (total > maxBytes) {
              res.destroy();
              return fail(new SsrfError('RESPONSE_TOO_LARGE', 'Phản hồi vượt quá kích thước cho phép'));
            }
            chunks.push(c);
          });
          res.on('error', fail);
          res.on('end', () => {
            if (settled) return;
            settled = true;
            const respHeaders = new Headers();
            for (const [k, v] of Object.entries(res.headers)) {
              if (v == null) continue;
              respHeaders.set(k, Array.isArray(v) ? v.join(', ') : String(v));
            }
            // Response không cho phép body với status 204/304
            const noBody = status === 204 || status === 304;
            resolve(
              new Response(noBody ? null : new Uint8Array(Buffer.concat(chunks)), {
                status,
                statusText: res.statusMessage ?? '',
                headers: respHeaders,
              }),
            );
          });
        },
      );

      req.setTimeout(timeoutMs, () => {
        req.destroy(new SsrfError('TIMEOUT', 'Nhà cung cấp phản hồi quá lâu'));
      });
      req.on('error', fail);
      if (body) req.write(body);
      req.end();
    });
  };
}
