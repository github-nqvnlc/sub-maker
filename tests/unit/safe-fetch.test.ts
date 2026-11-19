import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSafeFetch, isForbiddenAddress, resolveSafeTarget, SsrfError } from '@/lib/security/safe-fetch';

let server: http.Server;
let port: number;
let lastHost = '';

beforeAll(async () => {
  server = http.createServer((req, res) => {
    lastHost = String(req.headers.host);
    if (req.url === '/redirect') {
      res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
      return res.end();
    }
    if (req.url === '/big') {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      return res.end(Buffer.alloc(2048, 1));
    }
    if (req.url === '/slow') return; // không bao giờ phản hồi
    if (req.url === '/echo') {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ method: req.method, auth: req.headers.authorization, body: Buffer.concat(chunks).toString('utf8') }));
      });
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

describe('isForbiddenAddress', () => {
  it.each([
    ['127.0.0.1'],
    ['10.1.2.3'],
    ['172.16.5.5'],
    ['172.31.255.255'],
    ['192.168.1.1'],
    ['100.64.0.1'],
    ['169.254.169.254'],
    ['0.0.0.0'],
    ['::1'],
    ['fe80::1'],
    ['fc00::1'],
    ['fd12:3456::1'],
    ['::ffff:127.0.0.1'],
    ['::ffff:7f00:1'],
    ['::ffff:169.254.169.254'],
  ])('chặn %s', (ip) => {
    expect(isForbiddenAddress(ip)).toBe(true);
  });

  it.each([['8.8.8.8'], ['1.1.1.1'], ['172.32.0.1'], ['2606:4700:4700::1111']])('cho phép %s', (ip) => {
    expect(isForbiddenAddress(ip)).toBe(false);
  });

  it('allowInsecure cho phép loopback/riêng tư nhưng LUÔN chặn link-local và metadata', () => {
    expect(isForbiddenAddress('127.0.0.1', { allowInsecure: true })).toBe(false);
    expect(isForbiddenAddress('192.168.1.5', { allowInsecure: true })).toBe(false);
    expect(isForbiddenAddress('169.254.169.254', { allowInsecure: true })).toBe(true);
    expect(isForbiddenAddress('fe80::1', { allowInsecure: true })).toBe(true);
  });
});

describe('resolveSafeTarget', () => {
  const pub = async () => ['93.184.216.34'];

  it('chỉ cho phép https khi không bật allowInsecure', async () => {
    await expect(resolveSafeTarget('http://example.com/x', { lookup: pub })).rejects.toMatchObject({ code: 'SCHEME_NOT_ALLOWED' });
    await expect(resolveSafeTarget('ftp://example.com/x', { lookup: pub })).rejects.toMatchObject({ code: 'SCHEME_NOT_ALLOWED' });
    await expect(resolveSafeTarget('https://example.com/x', { lookup: pub })).resolves.toMatchObject({ address: '93.184.216.34' });
  });

  it('chặn IP nội bộ viết trực tiếp, tên nội bộ và tên không có dấu chấm (dịch vụ Docker)', async () => {
    for (const u of ['https://127.0.0.1/', 'https://10.0.0.5/', 'https://[::1]/', 'https://169.254.169.254/latest', 'https://localhost/', 'https://postgres/', 'https://minio:9000/', 'https://db.internal/']) {
      await expect(resolveSafeTarget(u, { lookup: pub }), u).rejects.toBeInstanceOf(SsrfError);
    }
  });

  it('chặn thông tin đăng nhập nhúng trong URL', async () => {
    await expect(resolveSafeTarget('https://user:pw@example.com/', { lookup: pub })).rejects.toBeInstanceOf(SsrfError);
  });

  it('chặn khi DNS trả lẫn địa chỉ công khai và nội bộ (rebinding)', async () => {
    const mixed = async () => ['93.184.216.34', '10.0.0.1'];
    await expect(resolveSafeTarget('https://evil.example.com/', { lookup: mixed })).rejects.toMatchObject({ code: 'ADDRESS_NOT_ALLOWED' });
  });

  it('chặn khi tên miền phân giải về địa chỉ nội bộ', async () => {
    await expect(resolveSafeTarget('https://evil.example.com/', { lookup: async () => ['192.168.0.10'] })).rejects.toMatchObject({
      code: 'ADDRESS_NOT_ALLOWED',
    });
  });
});

describe('createSafeFetch', () => {
  const dev = { allowInsecure: true } as const;

  it('gọi được máy chủ cục bộ khi allowInsecure, gửi đúng method/header/body', async () => {
    const f = createSafeFetch(dev);
    const res = await f(`http://127.0.0.1:${port}/echo`, {
      method: 'POST',
      headers: { authorization: 'Bearer abc', 'content-type': 'application/json' },
      body: JSON.stringify({ x: 'Xin chào' }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { method: string; auth: string; body: string };
    expect(json.method).toBe('POST');
    expect(json.auth).toBe('Bearer abc');
    expect(JSON.parse(json.body)).toEqual({ x: 'Xin chào' });
  });

  it('không gọi được máy chủ cục bộ khi KHÔNG bật allowInsecure', async () => {
    const f = createSafeFetch();
    await expect(f(`http://127.0.0.1:${port}/`)).rejects.toBeInstanceOf(SsrfError);
  });

  it('ghim địa chỉ đã kiểm tra: tên miền giả phân giải về 127.0.0.1 vẫn kết nối đúng máy chủ đó', async () => {
    const f = createSafeFetch({ ...dev, lookup: async () => ['127.0.0.1'] });
    const res = await f(`http://fake-provider.example.com:${port}/`);
    expect(await res.text()).toBe('ok');
    expect(lastHost).toBe(`fake-provider.example.com:${port}`);
  });

  it('KHÔNG theo chuyển hướng (kể cả về metadata)', async () => {
    const f = createSafeFetch(dev);
    await expect(f(`http://127.0.0.1:${port}/redirect`)).rejects.toMatchObject({ code: 'REDIRECT_BLOCKED' });
  });

  it('từ chối phản hồi vượt quá kích thước cho phép', async () => {
    const f = createSafeFetch({ ...dev, maxBytes: 1024 });
    await expect(f(`http://127.0.0.1:${port}/big`)).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' });
  });

  it('hết thời gian chờ', async () => {
    const f = createSafeFetch({ ...dev, timeoutMs: 200 });
    await expect(f(`http://127.0.0.1:${port}/slow`)).rejects.toThrow();
  });

  it('hủy bằng AbortSignal', async () => {
    const f = createSafeFetch(dev);
    const ctrl = new AbortController();
    const p = f(`http://127.0.0.1:${port}/slow`, { signal: ctrl.signal });
    setTimeout(() => ctrl.abort(), 100);
    await expect(p).rejects.toThrow();
  });
});
