import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * T155 (Nguyên tắc I/II) — rà soát tĩnh mọi Route Handler:
 *  - đều bọc bằng `route()` (kiểm tra Origin chống CSRF cho thao tác ghi + ánh xạ lỗi chuẩn);
 *  - đều gọi `requireUser`/`requireAdmin` (trừ /api/auth do thư viện xác thực xử lý, vẫn bọc `route()`);
 *  - không route nào nhận `ownerId`/`owner_id` từ client: chủ sở hữu luôn lấy từ phiên.
 */
const API = path.resolve(process.cwd(), 'src/app/api');
const routes: { rel: string; src: string }[] = [];
(function scan(dir: string) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) scan(full);
    else if (ent.name === 'route.ts') routes.push({ rel: path.relative(API, full).replaceAll(path.sep, '/'), src: fs.readFileSync(full, 'utf8') });
  }
})(API);

const NO_GUARD_ALLOWED = new Set(['auth/[...all]/route.ts']);

describe('rà soát Route Handler', () => {
  it('tìm thấy các route', () => {
    expect(routes.length).toBeGreaterThan(30);
  });

  it.each(routes.map((r) => [r.rel, r.src] as const))('%s: bọc route() và có kiểm tra quyền', (rel, src) => {
    const exportsHandlers = [...src.matchAll(/export const (GET|POST|PUT|PATCH|DELETE)\s*=\s*([^\n(]*)/g)];
    expect(exportsHandlers.length, 'không có handler nào').toBeGreaterThan(0);
    for (const m of exportsHandlers) expect(m[2]!.trim(), `${rel}: ${m[1]} chưa bọc route()`).toMatch(/^route\b|^route$/);
    if (!NO_GUARD_ALLOWED.has(rel)) expect(/requireUser|requireAdmin/.test(src), `${rel}: thiếu requireUser/requireAdmin`).toBe(true);
  });

  it('không route nào đọc ownerId/owner_id từ client', () => {
    const offenders = routes.filter((r) => /owner_?id/i.test(r.src)).map((r) => r.rel);
    expect(offenders).toEqual([]);
  });

  it('route /admin/* dùng requireAdmin (không phải requireUser)', () => {
    for (const r of routes.filter((x) => x.rel.startsWith('admin/'))) {
      expect(r.src, r.rel).toContain('requireAdmin');
      expect(r.src, r.rel).not.toContain('requireUser');
    }
  });
});
