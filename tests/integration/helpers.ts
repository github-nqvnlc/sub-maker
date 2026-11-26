import fs from 'node:fs';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { seedSystemSettings } from '@/lib/db/seed';
import { seedAdmin } from '@/lib/auth/seed-admin';
import { deleteByPrefix, ensureBucket } from '@/lib/storage/client';

/**
 * Hạ tầng kiểm thử tích hợp: gọi trực tiếp Route Handler của Next.js như một ứng dụng thu nhỏ
 * (không cần chạy máy chủ), có cookie jar, tạo User/Admin, đặt lại dữ liệu.
 */

const API_ROOT = path.resolve(process.cwd(), 'src/app/api');
const ORIGIN = 'http://localhost:3000';

type RouteEntry = { segments: string[]; file: string };
let routeTable: RouteEntry[] | null = null;

function scanRoutes(dir: string, segs: string[] = [], out: RouteEntry[] = []): RouteEntry[] {
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) scanRoutes(full, [...segs, ent.name], out);
    else if (ent.name === 'route.ts') out.push({ segments: segs, file: full });
  }
  return out;
}

export function getRouteTable(): RouteEntry[] {
  return (routeTable ??= scanRoutes(API_ROOT));
}

function matchRoute(pathname: string): { file: string; params: Record<string, string | string[]> } | null {
  const parts = pathname.replace(/^\/api\//, '').split('/').filter(Boolean);
  // Ưu tiên đường dẫn tĩnh trước động
  const candidates = [...getRouteTable()].sort((a, b) => scoreRoute(b.segments) - scoreRoute(a.segments));
  for (const r of candidates) {
    const params: Record<string, string | string[]> = {};
    let ok = true;
    let i = 0;
    for (const seg of r.segments) {
      const catchAll = /^\[\.\.\.(.+)\]$/.exec(seg);
      const dynamic = /^\[(.+)\]$/.exec(seg);
      if (catchAll) {
        params[catchAll[1]!] = parts.slice(i);
        i = parts.length;
        break;
      }
      if (dynamic) {
        if (i >= parts.length) { ok = false; break; }
        params[dynamic[1]!] = decodeURIComponent(parts[i]!);
        i++;
      } else {
        if (parts[i] !== seg) { ok = false; break; }
        i++;
      }
    }
    if (ok && i === parts.length) return { file: r.file, params };
  }
  return null;
}

function scoreRoute(segments: string[]): number {
  return segments.reduce((s, seg) => s + (seg.startsWith('[...') ? 0 : seg.startsWith('[') ? 1 : 3), 0);
}

/** Route có tồn tại và có export đúng method không (dùng cho bộ kiểm thử cô lập). */
export async function routeExists(method: string, pathname: string): Promise<boolean> {
  const m = matchRoute(pathname);
  if (!m) return false;
  const mod = (await import(/* @vite-ignore */ m.file)) as Record<string, unknown>;
  return typeof mod[method.toUpperCase()] === 'function';
}

export type CallInit = {
  json?: unknown;
  form?: FormData;
  body?: BodyInit;
  headers?: Record<string, string>;
  /** Mặc định có Origin hợp lệ cho yêu cầu ghi. Đặt `false` để thử thiếu Origin. */
  origin?: string | false;
};

export class TestClient {
  private cookies = new Map<string, string>();
  constructor(public label = 'anon') {}

  /** Đặt cookie thủ công (ví dụ `locale` — spec 003) vào jar của client. */
  setCookie(name: string, value: string): void {
    this.cookies.set(name, value);
  }

  cookieHeader(): string {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  private store(res: Response) {
    for (const sc of res.headers.getSetCookie?.() ?? []) {
      const [pair] = sc.split(';');
      const eq = pair!.indexOf('=');
      const name = pair!.slice(0, eq).trim();
      const value = pair!.slice(eq + 1).trim();
      if (!value || /max-age=0/i.test(sc) || /expires=thu, 01 jan 1970/i.test(sc)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  async request(method: string, pathname: string, init: CallInit = {}): Promise<Response> {
    const url = new URL(pathname, ORIGIN);
    const matched = matchRoute(url.pathname);
    if (!matched) throw new Error(`Không có route cho ${method} ${url.pathname}`);
    const mod = (await import(/* @vite-ignore */ matched.file)) as Record<string, unknown>;
    const handler = mod[method.toUpperCase()] as ((req: Request, ctx: unknown) => Promise<Response>) | undefined;
    if (!handler) return new Response(null, { status: 405 });

    const headers = new Headers(init.headers);
    if (this.cookies.size) headers.set('cookie', this.cookieHeader());
    if (init.origin !== false && method.toUpperCase() !== 'GET' && method.toUpperCase() !== 'HEAD') {
      headers.set('origin', init.origin ?? ORIGIN);
    }
    let body: BodyInit | undefined;
    if (init.json !== undefined) {
      headers.set('content-type', 'application/json');
      body = JSON.stringify(init.json);
    } else if (init.form) body = init.form;
    else if (init.body !== undefined) body = init.body;

    const req = new Request(url, { method, headers, body });
    const res = await handler(req, { params: Promise.resolve(matched.params) });
    this.store(res);
    return res;
  }

  get = (p: string, init?: CallInit) => this.request('GET', p, init);
  post = (p: string, init?: CallInit) => this.request('POST', p, init);
  put = (p: string, init?: CallInit) => this.request('PUT', p, init);
  patch = (p: string, init?: CallInit) => this.request('PATCH', p, init);
  delete = (p: string, init?: CallInit) => this.request('DELETE', p, init);
}

export const TEST_PASSWORD = 'Strong-Pass-7kQ!x2Lm';
let counter = 0;
export const uniqueEmail = (prefix = 'user') => `${prefix}-${Date.now().toString(36)}-${++counter}@example.test`;

export type TestUser = { client: TestClient; id: string; email: string; password: string };

/** Đăng ký User mới qua API thật và trả client đã đăng nhập. */
export async function createUser(opts: { email?: string; password?: string; name?: string } = {}): Promise<TestUser> {
  const email = opts.email ?? uniqueEmail();
  const password = opts.password ?? TEST_PASSWORD;
  const client = new TestClient(email);
  const res = await client.post('/api/auth/sign-up/email', { json: { email, password, name: opts.name ?? 'Người dùng thử' } });
  if (!res.ok) throw new Error(`Đăng ký thất bại: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { user: { id: string } };
  return { client, id: body.user.id, email, password };
}

export async function signIn(email: string, password: string): Promise<{ client: TestClient; res: Response }> {
  const client = new TestClient(email);
  const res = await client.post('/api/auth/sign-in/email', { json: { email, password } });
  return { client, res };
}

/** Seed Administrator (từ ADMIN_EMAIL/ADMIN_PASSWORD của môi trường test) và đăng nhập. */
export async function createAdmin(): Promise<TestUser> {
  await seedAdmin();
  const email = process.env.ADMIN_EMAIL!;
  const password = process.env.ADMIN_PASSWORD!;
  const { client, res } = await signIn(email, password);
  if (!res.ok) throw new Error(`Đăng nhập admin thất bại: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { user: { id: string } };
  return { client, id: body.user.id, email, password };
}

/** Xóa sạch dữ liệu (giữ cấu trúc) và nạp lại cài đặt mặc định; dọn đối tượng MinIO của User. */
export async function resetDb(): Promise<void> {
  const db = getDb();
  await db.execute(sql`
    TRUNCATE TABLE job_logs, job_segments, voices, voice_jobs, audio_cache, usage_records,
      video_job_logs, video_exports, video_cues, video_upload_parts, video_uploads, video_jobs, video_project_settings,
      stt_job_logs, stt_jobs, custom_ai_providers, stt_provider_configs,
      segments, subtitle_files, projects, ai_provider_configs,
      sessions, accounts, verifications, rate_limits, users, system_settings
    RESTART IDENTITY CASCADE`);
  await seedSystemSettings(db);
  await ensureBucket();
  await deleteByPrefix('users/');
}

/** Xóa riêng bộ đếm giới hạn tốc độ (để các test không ảnh hưởng nhau). */
export async function clearRateLimits(): Promise<void> {
  await getDb().execute(sql`TRUNCATE TABLE rate_limits`);
}
