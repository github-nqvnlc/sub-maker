import { eq } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { TestClient, TEST_PASSWORD, clearRateLimits, createUser, resetDb, signIn } from './helpers';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 1)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x20, 0, 0, 0]), Buffer.from('WEBP'), Buffer.alloc(40, 2)]);

const fileForm = (bytes: Buffer | Uint8Array, name = 'a.bin', type = 'application/octet-stream') => {
  const f = new FormData();
  f.set('file', new File([new Uint8Array(bytes)], name, { type }));
  return f;
};

beforeAll(async () => {
  await resetDb();
});
beforeEach(async () => {
  await clearRateLimits();
});

describe('GET/PATCH /api/me', () => {
  it('chưa đăng nhập → 401', async () => {
    expect((await new TestClient().get('/api/me')).status).toBe(401);
  });

  it('trả hồ sơ của chính mình kèm dung lượng và hạn mức', async () => {
    const u = await createUser({ name: 'Trần Thị B' });
    const res = await u.client.get('/api/me');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      id: u.id,
      email: u.email,
      displayName: 'Trần Thị B',
      role: 'user',
      canUseCustomAi: false,
      hasAvatar: false,
      storageUsedBytes: 0,
      storageQuotaBytes: 524288000,
    });
  });

  it('sửa tên hiển thị và giới thiệu', async () => {
    const u = await createUser();
    const res = await u.client.patch('/api/me', { json: { displayName: '  Lê Văn C  ', bio: 'Xin chào, tôi làm video.' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ displayName: 'Lê Văn C', bio: 'Xin chào, tôi làm video.' });
    // xóa giới thiệu bằng chuỗi rỗng
    const cleared = await u.client.patch('/api/me', { json: { bio: '' } });
    expect((await cleared.json()).bio).toBeNull();
  });

  it.each([
    ['tên rỗng', { displayName: '' }, 'displayName'],
    ['tên chỉ khoảng trắng', { displayName: '   ' }, 'displayName'],
    ['tên 61 ký tự', { displayName: 'x'.repeat(61) }, 'displayName'],
    ['giới thiệu 501 ký tự', { bio: 'y'.repeat(501) }, 'bio'],
    ['trường lạ (cố đặt role)', { role: 'admin' }, '_'],
  ])('%s → 422', async (_l, payload, field) => {
    const u = await createUser();
    const res = await u.client.patch('/api/me', { json: payload });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe('VALIDATION');
    expect(Object.keys(body.error.fields)).toContain(field);
  });

  it('tên 60 ký tự và giới thiệu 500 ký tự là hợp lệ (biên)', async () => {
    const u = await createUser();
    const res = await u.client.patch('/api/me', { json: { displayName: 'x'.repeat(60), bio: 'y'.repeat(500) } });
    expect(res.status).toBe(200);
  });

  it('thiếu hoặc sai Origin khi ghi → 403 (CSRF)', async () => {
    const u = await createUser();
    expect((await u.client.patch('/api/me', { json: { bio: 'a' }, origin: false })).status).toBe(403);
    expect((await u.client.patch('/api/me', { json: { bio: 'a' }, origin: 'https://evil.example' })).status).toBe(403);
  });

  it('không thể tự nâng quyền qua PATCH', async () => {
    const u = await createUser();
    await u.client.patch('/api/me', { json: { role: 'admin', canUseCustomAi: true } });
    const [row] = await getDb().select().from(users).where(eq(users.id, u.id));
    expect(row).toMatchObject({ role: 'user', canUseCustomAi: false });
  });
});

describe('ảnh đại diện', () => {
  it.each([
    ['PNG', PNG, 'image/png'],
    ['JPEG', JPEG, 'image/jpeg'],
    ['WebP', WEBP, 'image/webp'],
  ])('nhận %s (nhận diện bằng magic bytes) và phát lại đúng loại', async (_n, bytes, mime) => {
    const u = await createUser();
    const put = await u.client.put('/api/me/avatar', { form: fileForm(bytes, 'tên-sai.txt', 'text/plain') });
    expect(put.status).toBe(200);
    const get = await u.client.get('/api/me/avatar');
    expect(get.status).toBe(200);
    expect(get.headers.get('content-type')).toBe(mime);
    expect(Buffer.from(await get.arrayBuffer()).equals(bytes)).toBe(true);
    expect((await (await u.client.get('/api/me')).json()).hasAvatar).toBe(true);
  });

  it('từ chối tệp không phải ảnh dù đặt tên .png và Content-Type image/png', async () => {
    const u = await createUser();
    const res = await u.client.put('/api/me/avatar', { form: fileForm(Buffer.from('<?php echo 1; ?>'), 'x.png', 'image/png') });
    expect(res.status).toBe(422);
    expect((await u.client.get('/api/me/avatar')).status).toBe(404);
  });

  it('từ chối ảnh lớn hơn 1 MB (413) và ảnh rỗng (422)', async () => {
    const u = await createUser();
    const big = Buffer.concat([PNG, Buffer.alloc(1024 * 1024 + 10)]);
    expect((await u.client.put('/api/me/avatar', { form: fileForm(big) })).status).toBe(413);
    expect((await u.client.put('/api/me/avatar', { form: fileForm(Buffer.alloc(0)) })).status).toBe(422);
  });

  it('thiếu tệp → 422', async () => {
    const u = await createUser();
    expect((await u.client.put('/api/me/avatar', { form: new FormData() })).status).toBe(422);
  });

  it('dung lượng được tính đúng khi thêm, thay và xóa ảnh', async () => {
    const u = await createUser();
    await u.client.put('/api/me/avatar', { form: fileForm(PNG) });
    const used = async () => (await (await u.client.get('/api/me')).json()).storageUsedBytes as number;
    expect(await used()).toBe(PNG.length);
    // thay ảnh: chỉ tính chênh lệch, không cộng dồn
    await u.client.put('/api/me/avatar', { form: fileForm(JPEG) });
    expect(await used()).toBe(JPEG.length);
    const del = await u.client.delete('/api/me/avatar');
    expect(del.status).toBe(204);
    expect(await used()).toBe(0);
    expect((await (await u.client.get('/api/me')).json()).hasAvatar).toBe(false);
  });

  it('vượt hạn mức lưu trữ → 409 QUOTA_EXCEEDED và không đổi số liệu', async () => {
    const u = await createUser();
    await getDb().update(users).set({ storageUsedBytes: 524288000 - 10 }).where(eq(users.id, u.id));
    const res = await u.client.put('/api/me/avatar', { form: fileForm(PNG) });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('QUOTA_EXCEEDED');
    const [row] = await getDb().select().from(users).where(eq(users.id, u.id));
    expect(row!.storageUsedBytes).toBe(524288000 - 10);
  });
});

describe('POST /api/me/password', () => {
  it('đổi mật khẩu đúng cách: mật khẩu cũ hết hiệu lực, mật khẩu mới dùng được', async () => {
    const u = await createUser();
    const newPassword = 'Mat-Khau-Moi-8nP!zq';
    const res = await u.client.post('/api/me/password', { json: { currentPassword: u.password, newPassword } });
    expect(res.status).toBe(204);
    expect((await signIn(u.email, u.password)).res.ok).toBe(false);
    expect((await signIn(u.email, newPassword)).res.ok).toBe(true);
  });

  it('sai mật khẩu hiện tại → 422 trên đúng trường', async () => {
    const u = await createUser();
    const res = await u.client.post('/api/me/password', { json: { currentPassword: 'Sai-Mat-Khau-0!', newPassword: 'Mat-Khau-Moi-8nP!zq' } });
    expect(res.status).toBe(422);
    expect((await res.json()).error.fields).toHaveProperty('currentPassword');
  });

  it.each([
    ['ngắn', 'Ab1!'],
    ['toàn chữ số', '12345678901'],
    ['phổ biến', 'password123'],
  ])('mật khẩu mới %s vi phạm chính sách → 422', async (_l, newPassword) => {
    const u = await createUser();
    const res = await u.client.post('/api/me/password', { json: { currentPassword: TEST_PASSWORD, newPassword } });
    expect(res.status).toBe(422);
    expect((await res.json()).error.fields).toHaveProperty('newPassword');
    expect((await signIn(u.email, TEST_PASSWORD)).res.ok).toBe(true);
  });

  it('chưa đăng nhập → 401', async () => {
    expect((await new TestClient().post('/api/me/password', { json: { currentPassword: 'x', newPassword: 'y' } })).status).toBe(401);
  });
});
