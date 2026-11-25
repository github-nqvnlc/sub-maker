import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { childEnv } from '@/worker/render/spawn-render';

/** Tiến trình con dựng hình không nhận bí mật (spec 005, Nguyên tắc II, overlay-engine §8, T095). */

const SECRETS = {
  DATABASE_URL: 'postgres://user:secret-db-pass@host/db',
  S3_ACCESS_KEY: 'minio-access',
  S3_SECRET_KEY: 'minio-secret-value',
  S3_ENDPOINT: 'http://minio:9000',
  BETTER_AUTH_SECRET: 'auth-secret-value',
  CREDENTIALS_ENCRYPTION_KEY: 'encryption-key-value',
  ENCRYPTION_KEY: 'encryption-key-value',
  ADMIN_EMAIL: 'admin@example.test',
  ADMIN_PASSWORD: 'admin-secret-pass',
  SONIOX_API_KEY: 'sk-soniox-secret',
  FPT_API_KEY: 'sk-fpt-secret',
  NODE_OPTIONS: '--require ./evil.js',
  HTTPS_PROXY: 'http://user:pass@proxy',
};
const saved = { ...process.env };
afterEach(() => {
  for (const k of Object.keys(SECRETS)) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('môi trường của tiến trình con', () => {
  it('chỉ gồm đường dẫn, ffmpeg, thư mục tạm và ngôn ngữ; không có bí mật nào', () => {
    const env = childEnv({ ...SECRETS, PATH: '/usr/bin', FFMPEG_PATH: '/usr/bin/ffmpeg', TMPDIR: '/tmp', LANG: 'C.UTF-8', NODE_ENV: 'production' } as NodeJS.ProcessEnv);
    expect(env).toEqual({ PATH: '/usr/bin', FFMPEG_PATH: '/usr/bin/ffmpeg', TMPDIR: '/tmp', LANG: 'C.UTF-8', NODE_ENV: 'production' });
  });

  it('mọi biến khai báo trong .env.example đều không lọt sang', () => {
    const names = readFileSync(path.resolve('.env.example'), 'utf8')
      .split(/\r?\n/)
      .map((l) => /^#?\s*([A-Z][A-Z0-9_]+)=/.exec(l)?.[1])
      .filter((x): x is string => !!x);
    expect(names.length).toBeGreaterThan(5);
    const env = childEnv(Object.fromEntries(names.map((n) => [n, `secret-${n}`])) as NodeJS.ProcessEnv);
    const leaked = Object.keys(env).filter((k) => !['FFMPEG_PATH', 'NODE_ENV'].includes(k));
    expect(leaked).toEqual([]);
  });

  it('tiến trình thật chạy với môi trường này không đọc được bí mật của cha', async () => {
    Object.assign(process.env, SECRETS);
    delete process.env.NODE_OPTIONS; // không để ảnh hưởng tiến trình kiểm thử
    const out = await new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.env))'], { env: childEnv(), stdio: ['ignore', 'pipe', 'inherit'] });
      let s = '';
      child.stdout.on('data', (c: Buffer) => (s += c.toString('utf8')));
      child.on('error', reject);
      child.on('close', () => resolve(s));
    });
    for (const [k, v] of Object.entries(SECRETS)) {
      expect(out, k).not.toContain(v);
      expect(Object.keys(JSON.parse(out) as object)).not.toContain(k);
    }
  });

  it('tiến trình con và việc chuyển âm thanh đều chạy qua môi trường tối thiểu', () => {
    const read = (f: string) => readFileSync(path.resolve('src/worker', f), 'utf8');
    expect(read('render/spawn-render.ts')).toMatch(/fork\([^)]*env: childEnv\(\)/s);
    expect(read('jobs/prepare-overlay-audio.ts')).toMatch(/spawn\([^)]*env: childEnv\(\)/s);
    // tiến trình con không nhập mô-đun CSDL, kho lưu trữ hay cấu hình bí mật
    const main = read('render/main.ts');
    expect(main).not.toMatch(/lib\/(db|storage|env|crypto|settings|providers)/);
  });
});
