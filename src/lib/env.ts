import { z } from 'zod';

const boolString = z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true');

const schema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL là bắt buộc'),
  S3_ENDPOINT: z.string().min(1, 'S3_ENDPOINT là bắt buộc'),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().min(1, 'S3_BUCKET là bắt buộc'),
  S3_ACCESS_KEY: z.string().min(1, 'S3_ACCESS_KEY là bắt buộc'),
  S3_SECRET_KEY: z.string().min(1, 'S3_SECRET_KEY là bắt buộc'),
  APP_ENCRYPTION_KEY: z
    .string()
    .min(1, 'APP_ENCRYPTION_KEY là bắt buộc')
    .refine((v) => Buffer.from(v, 'base64').length === 32, 'APP_ENCRYPTION_KEY phải là 32 byte mã hóa base64'),
  AUTH_SECRET: z.string().min(32, 'AUTH_SECRET phải dài ít nhất 32 ký tự'),
  APP_URL: z.string().url('APP_URL phải là URL hợp lệ'),
  ADMIN_EMAIL: z.string().email('ADMIN_EMAIL không hợp lệ'),
  ADMIN_PASSWORD: z.string().min(10, 'ADMIN_PASSWORD phải dài ít nhất 10 ký tự'),
  ALLOW_INSECURE_PROVIDER_URLS: boolString,
  // Giới hạn tốc độ xác thực (mặc định an toàn; chỉ nới ở môi trường E2E/kiểm thử)
  RATE_LIMIT_SIGNIN_PER_MIN: z.coerce.number().int().min(1).default(5),
  RATE_LIMIT_SIGNUP_PER_HOUR: z.coerce.number().int().min(1).default(5),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

/**
 * Đọc và kiểm tra biến môi trường (lười, chỉ chạy khi cần để `next build` không phụ thuộc .env).
 * Thiếu hoặc sai → lỗi nêu rõ biến nào.
 */
export function env(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `- ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Cấu hình môi trường không hợp lệ:\n${lines}`);
  }
  // E2E chạy bản build production với máy chủ nhà cung cấp giả (http, loopback) nên có cờ riêng E2E_MODE=1;
  // KHÔNG bao giờ đặt E2E_MODE ở môi trường thật.
  if (parsed.data.NODE_ENV === 'production' && parsed.data.ALLOW_INSECURE_PROVIDER_URLS && process.env.E2E_MODE !== '1') {
    throw new Error('ALLOW_INSECURE_PROVIDER_URLS phải là false ở production');
  }
  cached = parsed.data;
  return cached;
}

/** Chỉ dùng trong kiểm thử để nạp lại cấu hình. */
export function resetEnvCache() {
  cached = null;
}
