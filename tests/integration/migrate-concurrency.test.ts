import pg from 'pg';
import { describe, expect, it } from 'vitest';

/**
 * Web (instrumentation) và worker cùng khởi động sẽ cùng gọi runMigrations() trên CSDL TRỐNG.
 * Phải không tranh nhau tạo bảng (lỗi "already exists" làm tiến trình chết).
 */
describe('migration chạy đồng thời', () => {
  it('nhiều tiến trình cùng migrate một CSDL trống đều thành công và kết quả nhất quán', async () => {
    const dev = new URL(process.env.DEV_DATABASE_URL ?? process.env.DATABASE_URL!);
    const name = `submaker_mig_${Date.now().toString(36)}`;
    const admin = new pg.Client({ connectionString: Object.assign(new URL(dev), { pathname: '/postgres' }).toString() });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${name}"`);
    const url = Object.assign(new URL(dev), { pathname: `/${name}` }).toString();
    try {
      // Mỗi "tiến trình" dùng pool riêng bằng cách chạy tập lệnh migrate trong tiến trình con với DATABASE_URL riêng
      const { spawn } = await import('node:child_process');
      const run = () =>
        new Promise<{ code: number | null; out: string }>((resolve) => {
          const child = spawn('npx', ['tsx', 'src/lib/db/migrate.ts'], { env: { ...process.env, DATABASE_URL: url }, shell: true });
          let out = '';
          child.stdout.on('data', (d) => (out += d));
          child.stderr.on('data', (d) => (out += d));
          child.on('close', (code) => resolve({ code, out }));
        });
      const results = await Promise.all([run(), run(), run()]);
      for (const r of results) expect(r.code, r.out).toBe(0);

      const check = new pg.Client({ connectionString: url });
      await check.connect();
      const tables = await check.query(`select count(*)::int as n from information_schema.tables where table_schema='public' and table_name='users'`);
      const settings = await check.query(`select count(*)::int as n from system_settings`);
      await check.end();
      expect(tables.rows[0].n).toBe(1);
      expect(settings.rows[0].n).toBe(5); // seed không bị nhân đôi
    } finally {
      await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await admin.end();
    }
  }, 120_000);
});
