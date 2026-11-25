import type { NextConfig } from 'next';

const isProd = process.env.NODE_ENV === 'production';

/**
 * CSP chặt theo nguyên tắc "chỉ cùng nguồn". Next.js cần script nội tuyến cho dữ liệu hydrate nên cho phép
 * 'unsafe-inline' cho script; 'unsafe-eval' chỉ ở môi trường dev (React Refresh). Ảnh/âm thanh chỉ từ cùng nguồn
 * (avatar và voice đều đi qua proxy xác thực của chính ứng dụng).
 */
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isProd ? '' : " 'unsafe-eval'"}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const securityHeaders = [
  { key: 'Content-Security-Policy', value: csp },
  ...(isProd ? [{ key: 'Strict-Transport-Security', value: 'max-age=31536000' }] : []),
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
];

const nextConfig: NextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  serverExternalPackages: ['pg', 'pg-boss', '@napi-rs/canvas'],
  // Máy ít bộ nhớ (hoặc đang chạy nhiều tiến trình khác) có thể hết bộ nhớ khi build với nhiều worker: đặt NEXT_BUILD_CPUS=2 để giảm.
  ...(Number(process.env.NEXT_BUILD_CPUS) > 0 ? { experimental: { cpus: Number(process.env.NEXT_BUILD_CPUS) } } : {}),
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
