import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

/**
 * Chạy một lần trước bộ kiểm thử tích hợp/cô lập: tạo mới CSDL test (đã có extension), chạy migration,
 * tạo bucket test và dọn sạch. Không đụng dữ liệu dev.
 * Idempotent: khi nhiều project vitest cùng khai báo globalSetup, chỉ lần đầu thực sự chạy.
 */
export default async function setup() {
  if (process.env.__SUBMAKER_TEST_DB_READY === '1') return;

  const envFile = path.resolve(process.cwd(), '.env');
  if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

  const devUrl = process.env.DEV_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!devUrl) throw new Error('Thiếu DATABASE_URL (đặt trong .env) để chạy kiểm thử tích hợp');
  process.env.DEV_DATABASE_URL = devUrl;
  const testDb = process.env.TEST_DB_NAME ?? 'submaker_test';
  if (testDb === new URL(devUrl).pathname.slice(1)) throw new Error('TEST_DB_NAME không được trùng CSDL dev');

  // 1) Tạo lại CSDL test
  const adminUrl = new URL(devUrl);
  adminUrl.pathname = '/postgres';
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS "${testDb}" WITH (FORCE)`);
  await admin.query(`CREATE DATABASE "${testDb}"`);
  await admin.end();

  // 2) Đặt biến môi trường cho tiến trình chính rồi chạy migration
  const testUrl = new URL(devUrl);
  testUrl.pathname = `/${testDb}`;
  process.env.DATABASE_URL = testUrl.toString();
  process.env.S3_BUCKET = process.env.TEST_S3_BUCKET ?? 'submaker-test';
  process.env.APP_URL = 'http://localhost:3000';
  process.env.ALLOW_INSECURE_PROVIDER_URLS = 'true';

  const { runMigrations } = await import('../../src/lib/db/migrate');
  await runMigrations();

  // 3) Bucket test sạch
  const { ensureBucket, deleteByPrefix } = await import('../../src/lib/storage/client');
  await ensureBucket();
  await deleteByPrefix('users/');

  const { closeDb } = await import('../../src/lib/db');
  await closeDb();
  process.env.__SUBMAKER_TEST_DB_READY = '1';

  return async () => {
    const { closeDb: close } = await import('../../src/lib/db');
    await close();
  };
}
