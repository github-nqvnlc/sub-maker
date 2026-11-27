/**
 * Khởi động môi trường E2E: CSDL + bucket RIÊNG (không đụng dữ liệu dev), rồi chạy web (đã build) và worker.
 * Playwright gọi script này qua `webServer.command`; giữ chạy đến khi bị dừng.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const PORT = process.env.E2E_PORT ?? '3100';
const E2E_DB = 'submaker_e2e';
const E2E_BUCKET = 'submaker-e2e';

export const E2E_ADMIN = { email: 'admin@e2e.test', password: 'Admin-E2E-7wQ!pL2m' };

const envFile = path.resolve(process.cwd(), '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const devUrl = process.env.DATABASE_URL;
if (!devUrl) throw new Error('Thiếu DATABASE_URL (.env) cho E2E');

async function prepareDb(): Promise<string> {
  const admin = new URL(devUrl!);
  admin.pathname = '/postgres';
  const client = new pg.Client({ connectionString: admin.toString() });
  await client.connect();
  await client.query(`DROP DATABASE IF EXISTS "${E2E_DB}" WITH (FORCE)`);
  await client.query(`CREATE DATABASE "${E2E_DB}"`);
  await client.end();
  const url = new URL(devUrl!);
  url.pathname = `/${E2E_DB}`;
  return url.toString();
}

const children: ChildProcess[] = [];
function stopAll() {
  for (const c of children) if (!c.killed) c.kill();
}
process.on('SIGTERM', () => {
  stopAll();
  process.exit(0);
});
process.on('SIGINT', () => {
  stopAll();
  process.exit(0);
});

async function main() {
  const dbUrl = await prepareDb();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: dbUrl,
    S3_BUCKET: E2E_BUCKET,
    APP_URL: `http://localhost:${PORT}`,
    ADMIN_EMAIL: E2E_ADMIN.email,
    ADMIN_PASSWORD: E2E_ADMIN.password,
    ALLOW_INSECURE_PROVIDER_URLS: 'true',
    E2E_MODE: '1',
    // Mọi test E2E cùng một IP nên nới giới hạn tốc độ (mặc định production vẫn là 5 đăng ký/giờ, 5 đăng nhập/phút)
    RATE_LIMIT_SIGNIN_PER_MIN: '1000',
    RATE_LIMIT_SIGNUP_PER_HOUR: '1000',
    NODE_ENV: 'production',
    PORT,
  };
  // Dùng chung tiến trình con để web (migration + seed trong instrumentation) và worker cùng CSDL E2E;
  // gọi thẳng Node entry thay cho npx/shell để tiết kiệm tiến trình và bộ nhớ ảo trên Windows.
  const nextBin = path.resolve(process.cwd(), 'node_modules/next/dist/bin/next');
  const tsxBin = path.resolve(process.cwd(), 'node_modules/tsx/dist/cli.mjs');
  const web = spawn(process.execPath, [nextBin, 'start', '-p', PORT], { env, stdio: 'inherit' });
  const worker = spawn(process.execPath, [tsxBin, 'src/worker/index.ts'], { env, stdio: 'inherit' });
  children.push(web, worker);
  const onChildExit = (name: string) => (code: number | null) => {
    if (code && code !== 0) console.error(`[e2e-up] ${name} thoát bất thường (mã ${code})`);
    stopAll();
    process.exit(code ?? 0);
  };
  web.on('exit', onChildExit('web'));
  worker.on('exit', onChildExit('worker'));
}

main().catch((e) => {
  console.error('[e2e-up]', e);
  process.exit(1);
});
