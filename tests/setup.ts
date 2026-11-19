import fs from 'node:fs';
import path from 'node:path';

// Nạp .env của dev (nếu có) trước, rồi ép các biến dành riêng cho kiểm thử.
const envFile = path.resolve(process.cwd(), '.env');
if (fs.existsSync(envFile)) {
  try {
    process.loadEnvFile(envFile);
  } catch {
    // bỏ qua: biến có thể đã được cung cấp từ bên ngoài
  }
}

const TEST_DB = (process.env.TEST_DB_NAME ??= 'submaker_test');
process.env.TEST_S3_BUCKET ??= 'submaker-test';

// Kiểm thử dùng CSDL và bucket riêng để không đụng dữ liệu dev.
if (process.env.DATABASE_URL) {
  const u = new URL(process.env.DATABASE_URL);
  process.env.DEV_DATABASE_URL ??= process.env.DATABASE_URL;
  u.pathname = `/${TEST_DB}`;
  process.env.DATABASE_URL = u.toString();
}
process.env.S3_BUCKET = process.env.TEST_S3_BUCKET;
process.env.APP_URL = 'http://localhost:3000';
process.env.ADMIN_EMAIL = 'admin@test.local';
process.env.ADMIN_PASSWORD = 'Admin-Test-9xQ!pL2m';
process.env.ALLOW_INSECURE_PROVIDER_URLS = 'true';
(process.env as Record<string, string>).NODE_ENV = 'test';
