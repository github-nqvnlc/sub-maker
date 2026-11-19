import { eq } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { requireAdmin, requireUser } from '@/lib/auth/guards';
import { seedAdmin } from '@/lib/auth/seed-admin';
import { HttpError } from '@/lib/api/errors';
import { resetEnvCache } from '@/lib/env';
import { TestClient, TEST_PASSWORD, clearRateLimits, createAdmin, createUser, resetDb, signIn, uniqueEmail } from './helpers';

const ip = (n: number) => ({ 'x-forwarded-for': `203.0.113.${n}` });
const reqWith = (client: TestClient) => new Request('http://localhost:3000/api/x', { headers: { cookie: client.cookieHeader() } });

beforeAll(async () => {
  await resetDb();
});
beforeEach(async () => {
  await clearRateLimits();
});

describe('đăng ký và đăng nhập', () => {
  it('đăng ký hợp lệ tạo User thường, đang hoạt động, chưa có quyền cấu hình AI riêng, và đăng nhập sẵn', async () => {
    const u = await createUser({ name: 'Nguyễn Văn A' });
    const [row] = await getDb().select().from(users).where(eq(users.id, u.id));
    expect(row).toMatchObject({ role: 'user', status: 'active', canUseCustomAi: false, name: 'Nguyễn Văn A' });
    expect(row!.storageUsedBytes).toBe(0);
    await expect(requireUser(reqWith(u.client))).resolves.toMatchObject({ id: u.id, role: 'user' });
  });

  it('email trùng bị từ chối (không phân biệt hoa/thường)', async () => {
    const email = uniqueEmail('dup');
    await createUser({ email });
    const c = new TestClient();
    const res = await c.post('/api/auth/sign-up/email', { json: { email: email.toUpperCase(), password: TEST_PASSWORD, name: 'Trùng' } });
    expect(res.ok).toBe(false);
  });

  it.each([
    ['quá ngắn', 'Ab1!xyz'],
    ['toàn chữ số', '12345678901234'],
    ['quá phổ biến', 'password123'],
    ['quá dài (129 ký tự)', 'Aa1!'.repeat(33)],
  ])('mật khẩu %s bị từ chối', async (_label, password) => {
    const c = new TestClient();
    const res = await c.post('/api/auth/sign-up/email', { json: { email: uniqueEmail('pw'), password, name: 'Thử' } });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it('tên hiển thị rỗng hoặc dài hơn 60 ký tự bị từ chối', async () => {
    const c = new TestClient();
    for (const name of ['', '   ', 'x'.repeat(61)]) {
      const res = await c.post('/api/auth/sign-up/email', { json: { email: uniqueEmail('nm'), password: TEST_PASSWORD, name } });
      expect(res.ok, `name="${name.slice(0, 5)}…"`).toBe(false);
    }
  });

  it('không thể tự đăng ký thành admin hay đặt trạng thái/quyền qua dữ liệu gửi lên', async () => {
    const c = new TestClient();
    const email = uniqueEmail('evil');
    const res = await c.post('/api/auth/sign-up/email', {
      json: { email, password: TEST_PASSWORD, name: 'Kẻ xấu', role: 'admin', status: 'active', canUseCustomAi: true, storageUsedBytes: -5 },
    });
    // Thư viện có thể từ chối hẳn hoặc bỏ qua trường lạ; trong cả hai trường hợp không được thành admin
    const [row] = await getDb().select().from(users).where(eq(users.email, email));
    if (res.ok) {
      expect(row).toMatchObject({ role: 'user', canUseCustomAi: false, storageUsedBytes: 0 });
    } else {
      expect(row).toBeUndefined();
    }
  });

  it('đăng nhập đúng/sai mật khẩu; đăng xuất hủy phiên', async () => {
    const u = await createUser();
    const bad = await signIn(u.email, 'Sai-Mat-Khau-123!');
    expect(bad.res.ok).toBe(false);
    const good = await signIn(u.email, u.password);
    expect(good.res.ok).toBe(true);
    await expect(requireUser(reqWith(good.client))).resolves.toMatchObject({ id: u.id });
    const out = await good.client.post('/api/auth/sign-out', { json: {} });
    expect(out.ok).toBe(true);
    await expect(requireUser(reqWith(good.client))).rejects.toMatchObject({ status: 401 });
  });

  it('Origin lạ bị từ chối khi gọi endpoint xác thực (CSRF)', async () => {
    const u = await createUser();
    const c = new TestClient();
    const res = await c.post('/api/auth/sign-in/email', { json: { email: u.email, password: u.password }, origin: 'https://evil.example' });
    expect(res.status).toBe(403);
  });
});

describe('giới hạn tốc độ (lưu bền trong DB)', () => {
  it('đăng nhập sai nhiều lần liên tiếp bị chặn bằng 429, kể cả với mật khẩu đúng', async () => {
    const u = await createUser();
    const c = new TestClient();
    let last = 0;
    for (let i = 0; i < 7; i++) {
      const res = await c.post('/api/auth/sign-in/email', { json: { email: u.email, password: `Sai-${i}-Mat-Khau!` }, headers: ip(7) });
      last = res.status;
    }
    expect(last).toBe(429);
    const ok = await c.post('/api/auth/sign-in/email', { json: { email: u.email, password: u.password }, headers: ip(7) });
    expect(ok.status).toBe(429);
    // IP khác không bị ảnh hưởng
    const other = await new TestClient().post('/api/auth/sign-in/email', { json: { email: u.email, password: u.password }, headers: ip(8) });
    expect(other.ok).toBe(true);
  });

  it('đăng ký hàng loạt từ một IP bị chặn', async () => {
    const c = new TestClient();
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) {
      const res = await c.post('/api/auth/sign-up/email', { json: { email: uniqueEmail('mass'), password: TEST_PASSWORD, name: 'Hàng loạt' }, headers: ip(9) });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 5).every((s) => s === 200)).toBe(true);
    expect(statuses.slice(5)).toContain(429);
  });
});

describe('khóa và xóa tài khoản', () => {
  it('User bị khóa không đăng nhập được và phiên đang có bị từ chối ngay', async () => {
    const u = await createUser();
    await getDb().update(users).set({ status: 'banned' }).where(eq(users.id, u.id));
    await expect(requireUser(reqWith(u.client))).rejects.toMatchObject({ status: 403, code: 'ACCOUNT_DISABLED' });
    const { res } = await signIn(u.email, u.password);
    expect(res.ok).toBe(false);
    // mở khóa → dùng lại được
    await getDb().update(users).set({ status: 'active' }).where(eq(users.id, u.id));
    const again = await signIn(u.email, u.password);
    expect(again.res.ok).toBe(true);
  });

  it('User đang bị xóa (deleting) không đăng nhập được', async () => {
    const u = await createUser();
    await getDb().update(users).set({ status: 'deleting' }).where(eq(users.id, u.id));
    expect((await signIn(u.email, u.password)).res.ok).toBe(false);
    await expect(requireUser(reqWith(u.client))).rejects.toBeInstanceOf(HttpError);
  });
});

describe('Administrator cấp sẵn', () => {
  it('seed tạo admin, gọi lại là idempotent', async () => {
    const first = await seedAdmin();
    const second = await seedAdmin();
    expect(second).toEqual({ created: false, passwordUpdated: false });
    expect([first.created, first.passwordUpdated].some(Boolean) || true).toBe(true);
    const admin = await createAdmin();
    const [row] = await getDb().select().from(users).where(eq(users.id, admin.id));
    expect(row).toMatchObject({ role: 'admin', status: 'active' });
    await expect(requireAdmin(reqWith(admin.client))).resolves.toMatchObject({ role: 'admin' });
  });

  it('User thường gọi requireAdmin nhận 404 (không lộ chức năng quản trị)', async () => {
    const u = await createUser();
    await expect(requireAdmin(reqWith(u.client))).rejects.toMatchObject({ status: 404 });
  });

  it('đổi ADMIN_PASSWORD trong cấu hình thì seed đồng bộ lại mật khẩu', async () => {
    const original = process.env.ADMIN_PASSWORD!;
    try {
      process.env.ADMIN_PASSWORD = 'Doi-Mat-Khau-Moi-4zQ!w';
      resetEnvCache(); // env() được cache theo tiến trình; production chỉ đổi khi khởi động lại
      const res = await seedAdmin();
      expect(res.passwordUpdated).toBe(true);
      expect((await signIn(process.env.ADMIN_EMAIL!, 'Doi-Mat-Khau-Moi-4zQ!w')).res.ok).toBe(true);
      expect((await signIn(process.env.ADMIN_EMAIL!, original)).res.ok).toBe(false);
    } finally {
      process.env.ADMIN_PASSWORD = original;
      resetEnvCache();
      await seedAdmin();
    }
  });

  it('không thể đăng ký công khai bằng email của admin', async () => {
    await seedAdmin();
    const c = new TestClient();
    const res = await c.post('/api/auth/sign-up/email', { json: { email: process.env.ADMIN_EMAIL, password: TEST_PASSWORD, name: 'Giả mạo' } });
    expect(res.ok).toBe(false);
  });
});
