import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '@/lib/db';
import { projects, sessions, usageRecords, users } from '@/lib/db/schema';
import { listKeys, putObject } from '@/lib/storage/client';
import { storageKeys } from '@/lib/storage/keys';
import { deleteUserData } from '@/worker/jobs/delete-user';
import { stopBoss } from '@/worker/queues';
import { TestClient, TEST_PASSWORD, clearRateLimits, createAdmin, createUser, resetDb, signIn, type TestUser } from './helpers';

let admin: TestUser;

beforeAll(async () => {
  await resetDb();
  admin = await createAdmin();
});
afterAll(async () => {
  await stopBoss();
});
beforeEach(async () => {
  await clearRateLimits();
});

describe('quyền truy cập /api/admin/users', () => {
  it('chưa đăng nhập → 401; User thường → 404 (không lộ chức năng quản trị)', async () => {
    expect((await new TestClient().get('/api/admin/users')).status).toBe(401);
    const u = await createUser();
    expect((await u.client.get('/api/admin/users')).status).toBe(404);
    expect((await u.client.patch(`/api/admin/users/${u.id}`, { json: { canUseCustomAi: true } })).status).toBe(404);
    expect((await u.client.delete(`/api/admin/users/${u.id}?confirm=${u.email}`)).status).toBe(404);
    expect((await u.client.post(`/api/admin/users/${u.id}/reset-password`, { json: { newPassword: 'Mat-Khau-Moi-8nP!zq' } })).status).toBe(404);
  });
});

describe('danh sách, tìm kiếm, lọc', () => {
  it('tìm theo email, theo tên không dấu, lọc trạng thái và quyền AI riêng, phân trang', async () => {
    const a = await createUser({ email: 'nguyen.an@example.test', name: 'Nguyễn Văn Ân' });
    const b = await createUser({ email: 'le.binh@example.test', name: 'Lê Bình' });
    await createUser({ email: 'tran.cuong@example.test', name: 'Trần Cường' });
    await admin.client.patch(`/api/admin/users/${b.id}`, { json: { status: 'banned' } });
    await admin.client.patch(`/api/admin/users/${a.id}`, { json: { canUseCustomAi: true } });

    const list = async (qs: string) => (await (await admin.client.get(`/api/admin/users?${qs}`)).json()) as { items: { email: string }[]; total: number };

    expect((await list('q=le.binh')).items.map((x) => x.email)).toEqual(['le.binh@example.test']);
    expect((await list('q=nguyen+van+an')).items.map((x) => x.email)).toEqual(['nguyen.an@example.test']); // không dấu
    expect((await list('q=C%C6%B0%E1%BB%9Dng')).items.map((x) => x.email)).toEqual(['tran.cuong@example.test']); // có dấu
    expect((await list('status=banned')).items.map((x) => x.email)).toEqual(['le.binh@example.test']);
    expect((await list('customAi=true')).items.map((x) => x.email)).toEqual(['nguyen.an@example.test']);

    const page1 = await list('pageSize=2&page=1');
    const page2 = await list('pageSize=2&page=2');
    expect(page1.items).toHaveLength(2);
    expect(page2.items.length).toBeGreaterThanOrEqual(1);
    expect(page1.total).toBeGreaterThanOrEqual(4); // gồm cả admin
  });

  it('ký tự đặc biệt của LIKE trong từ khóa được xử lý như chữ thường', async () => {
    const res = await admin.client.get('/api/admin/users?q=%25');
    expect(res.status).toBe(200);
    expect((await res.json()).items).toHaveLength(0);
  });

  it('tham số không hợp lệ → 422', async () => {
    expect((await admin.client.get('/api/admin/users?pageSize=1000')).status).toBe(422);
    expect((await admin.client.get('/api/admin/users?status=xyz')).status).toBe(422);
  });
});

describe('khóa / mở khóa / quyền AI riêng', () => {
  it('khóa User: đăng nhập thất bại và phiên đang có bị thu hồi; mở khóa dùng lại được', async () => {
    const u = await createUser();
    const res = await admin.client.patch(`/api/admin/users/${u.id}`, { json: { status: 'banned' } });
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('banned');
    expect(await getDb().select().from(sessions).where(eq(sessions.userId, u.id))).toHaveLength(0);
    expect((await u.client.get('/api/me')).status).toBe(401);
    expect((await signIn(u.email, u.password)).res.ok).toBe(false);

    await admin.client.patch(`/api/admin/users/${u.id}`, { json: { status: 'active' } });
    expect((await signIn(u.email, u.password)).res.ok).toBe(true);
  });

  it('bật/tắt can_use_custom_ai', async () => {
    const u = await createUser();
    const on = await admin.client.patch(`/api/admin/users/${u.id}`, { json: { canUseCustomAi: true } });
    expect((await on.json()).canUseCustomAi).toBe(true);
    expect((await (await u.client.get('/api/me')).json()).canUseCustomAi).toBe(true);
    const off = await admin.client.patch(`/api/admin/users/${u.id}`, { json: { canUseCustomAi: false } });
    expect((await off.json()).canUseCustomAi).toBe(false);
  });

  it('không thay đổi nào / trường lạ → 422; id không hợp lệ hoặc không tồn tại → 404', async () => {
    const u = await createUser();
    expect((await admin.client.patch(`/api/admin/users/${u.id}`, { json: {} })).status).toBe(422);
    expect((await admin.client.patch(`/api/admin/users/${u.id}`, { json: { role: 'admin' } })).status).toBe(422);
    expect((await admin.client.patch('/api/admin/users/not-a-uuid', { json: { status: 'banned' } })).status).toBe(404);
    expect((await admin.client.patch('/api/admin/users/00000000-0000-4000-8000-000000000000', { json: { status: 'banned' } })).status).toBe(404);
  });

  it('không khóa/xóa/đổi mật khẩu được tài khoản Administrator cấp sẵn → 409', async () => {
    expect((await admin.client.patch(`/api/admin/users/${admin.id}`, { json: { status: 'banned' } })).status).toBe(409);
    expect((await admin.client.delete(`/api/admin/users/${admin.id}?confirm=${admin.email}`)).status).toBe(409);
    expect((await admin.client.post(`/api/admin/users/${admin.id}/reset-password`, { json: { newPassword: 'Mat-Khau-Moi-8nP!zq' } })).status).toBe(409);
    expect((await signIn(admin.email, admin.password)).res.ok).toBe(true);
  });
});

describe('đặt lại mật khẩu', () => {
  it('User đăng nhập được bằng mật khẩu mới, mật khẩu cũ và phiên cũ hết hiệu lực', async () => {
    const u = await createUser();
    const newPassword = 'Admin-Dat-Lai-5hT!qw';
    const res = await admin.client.post(`/api/admin/users/${u.id}/reset-password`, { json: { newPassword } });
    expect(res.status).toBe(204);
    expect((await u.client.get('/api/me')).status).toBe(401);
    expect((await signIn(u.email, u.password)).res.ok).toBe(false);
    expect((await signIn(u.email, newPassword)).res.ok).toBe(true);
  });

  it('mật khẩu yếu → 422', async () => {
    const u = await createUser();
    const res = await admin.client.post(`/api/admin/users/${u.id}/reset-password`, { json: { newPassword: '12345678901' } });
    expect(res.status).toBe(422);
    expect((await signIn(u.email, TEST_PASSWORD)).res.ok).toBe(true);
  });
});

describe('xóa vĩnh viễn User', () => {
  it('cần confirm đúng email; sai/thiếu → 422', async () => {
    const u = await createUser();
    expect((await admin.client.delete(`/api/admin/users/${u.id}`)).status).toBe(422);
    expect((await admin.client.delete(`/api/admin/users/${u.id}?confirm=khac@example.test`)).status).toBe(422);
    const [row] = await getDb().select().from(users).where(eq(users.id, u.id));
    expect(row!.status).toBe('active');
  });

  it('xóa: chuyển deleting + chặn đăng nhập ngay; sau đó worker xóa sạch dữ liệu, MinIO và ẩn danh usage', async () => {
    const u = await createUser();
    // dữ liệu mẫu: Project, đối tượng MinIO, bản ghi usage
    const [proj] = await getDb().insert(projects).values({ ownerId: u.id, name: 'Dự án của tôi', providerType: 'fpt_marketplace' }).returning();
    await putObject(storageKeys.avatar(u.id), Buffer.from('x'), 'image/png');
    await putObject(storageKeys.audioCache(u.id, 'abc123'), Buffer.from('audio'), 'audio/wav');
    await getDb().insert(usageRecords).values({
      userId: u.id,
      projectId: proj!.id,
      providerType: 'fpt_marketplace',
      configScope: 'global',
      unitsChars: 1234,
      ok: true,
    });

    const res = await admin.client.delete(`/api/admin/users/${u.id}?confirm=${encodeURIComponent(u.email.toUpperCase())}`);
    expect(res.status).toBe(202);
    const [mid] = await getDb().select().from(users).where(eq(users.id, u.id));
    expect(mid!.status).toBe('deleting');
    expect((await signIn(u.email, u.password)).res.ok).toBe(false);
    expect((await u.client.get('/api/me')).status).toBe(401);

    // Chạy trực tiếp phần việc của worker (idempotent)
    const r = await deleteUserData(u.id);
    expect(r.existed).toBe(true);
    expect(r.objectsDeleted).toBe(2);

    expect(await getDb().select().from(users).where(eq(users.id, u.id))).toHaveLength(0);
    expect(await getDb().select().from(projects).where(eq(projects.ownerId, u.id))).toHaveLength(0);
    const remaining: string[] = [];
    for await (const k of listKeys(storageKeys.userPrefix(u.id))) remaining.push(k.key);
    expect(remaining).toEqual([]);

    // thống kê tổng hợp được giữ nhưng ẩn danh
    const usage = await getDb().select().from(usageRecords);
    const mine = usage.find((x) => x.unitsChars === 1234);
    expect(mine).toBeDefined();
    expect(mine!.userId).toBeNull();
    expect(mine!.projectId).toBeNull();

    // chạy lại không lỗi (idempotent)
    expect(await deleteUserData(u.id)).toMatchObject({ existed: false, objectsDeleted: 0 });
  });
});
