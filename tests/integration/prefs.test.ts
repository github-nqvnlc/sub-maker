import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TestClient, clearRateLimits, createUser, resetDb } from './helpers';

beforeAll(async () => {
  await resetDb();
});
beforeEach(async () => {
  await clearRateLimits();
});

describe('tùy chọn giao diện: locale/theme (spec 003, FR-016, FR-021)', () => {
  it('tài khoản mới có mặc định vi/system', async () => {
    const u = await createUser();
    expect(await (await u.client.get('/api/me')).json()).toMatchObject({ locale: 'vi', theme: 'system' });
  });

  it('PATCH lưu locale và theme, GET trả lại giá trị đã lưu', async () => {
    const u = await createUser();
    const res = await u.client.patch('/api/me', { json: { locale: 'en', theme: 'dark' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ locale: 'en', theme: 'dark' });
    expect(await (await u.client.get('/api/me')).json()).toMatchObject({ locale: 'en', theme: 'dark' });
    // đổi riêng một trường không làm mất trường kia
    const only = await u.client.patch('/api/me', { json: { theme: 'light' } });
    expect(await only.json()).toMatchObject({ locale: 'en', theme: 'light' });
  });

  it.each([
    ['locale lạ', { locale: 'fr' }],
    ['theme lạ', { theme: 'sepia' }],
    ['locale sai kiểu', { locale: 1 }],
  ])('%s → 422 và không đổi dữ liệu', async (_name, body) => {
    const u = await createUser();
    const res = await u.client.patch('/api/me', { json: body });
    expect(res.status).toBe(422);
    expect(await (await u.client.get('/api/me')).json()).toMatchObject({ locale: 'vi', theme: 'system' });
  });

  it('chưa đăng nhập → 401; người dùng A không đọc hay ghi được tùy chọn của B', async () => {
    expect((await new TestClient().patch('/api/me', { json: { theme: 'dark' } })).status).toBe(401);
    const a = await createUser();
    const b = await createUser();
    await a.client.patch('/api/me', { json: { locale: 'en', theme: 'dark' } });
    expect(await (await b.client.get('/api/me')).json()).toMatchObject({ locale: 'vi', theme: 'system' });
  });
});
