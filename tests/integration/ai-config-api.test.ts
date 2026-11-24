import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startMockProvider, type MockProvider } from '../../mock-provider/server';
import { getDb } from '@/lib/db';
import { aiProviderConfigs } from '@/lib/db/schema';
import { decryptSecret } from '@/lib/security/crypto';
import { resolveConfigForJob } from '@/lib/providers/config-service';
import { stopBoss } from '@/worker/queues';
import { TestClient, clearRateLimits, createAdmin, createUser, resetDb, type TestUser } from './helpers';

let mock: MockProvider;
let admin: TestUser;

const ADMIN_KEY = 'sk-admin-shared-key-AAAA1111';
const USER_KEY = 'sk-user-private-key-BBBB2222';

const marketplace = (scenario = 'ok') => `${mock.url}/s/${scenario}/v1`;
const input = (over: Record<string, unknown> = {}) => ({
  type: 'fpt_marketplace',
  baseUrl: marketplace(),
  apiKey: ADMIN_KEY,
  defaultModel: 'FPT.AI-VITs',
  defaultVoice: 'banmai',
  ...over,
});

async function rowFor(scope: 'global' | 'user', ownerId: string | null, type = 'fpt_marketplace') {
  const rows = await getDb().select().from(aiProviderConfigs).where(eq(aiProviderConfigs.type, type as 'fpt_marketplace'));
  return rows.find((r) => r.scope === scope && (r.ownerUserId ?? null) === ownerId) ?? null;
}

beforeAll(async () => {
  mock = await startMockProvider();
  await resetDb();
  admin = await createAdmin();
});
afterAll(async () => {
  await mock.close();
  await stopBoss();
});
beforeEach(async () => {
  await clearRateLimits();
  mock.reset();
  await getDb().delete(aiProviderConfigs);
});

describe('cấu hình AI chung (Administrator)', () => {
  it('tạo cấu hình: khóa được mã hóa, không bao giờ xuất hiện trong phản hồi', async () => {
    const res = await admin.client.put('/api/admin/ai-configs', { json: input() });
    expect(res.status).toBe(200);
    const text = await res.clone().text();
    expect(text).not.toContain(ADMIN_KEY);
    const body = await res.json();
    expect(body).toMatchObject({ scope: 'global', type: 'fpt_marketplace', apiKeyHint: '…1111', enabled: true, maxCharsPerRequest: 5000 });
    expect(body).not.toHaveProperty('apiKey');
    expect(body).not.toHaveProperty('apiKeyEnc');

    const row = await rowFor('global', null);
    expect(row!.apiKeyEnc.toString('utf8')).not.toContain('admin-shared');
    expect(decryptSecret(row!.apiKeyEnc)).toBe(ADMIN_KEY);

    const list = await admin.client.get('/api/admin/ai-configs');
    expect(await list.clone().text()).not.toContain(ADMIN_KEY);
    expect((await list.json()) as unknown[]).toHaveLength(1);
  });

  it('sửa với apiKey trống giữ khóa cũ; gửi khóa mới thì đổi khóa và gợi ý', async () => {
    await admin.client.put('/api/admin/ai-configs', { json: input() });
    const keep = await admin.client.put('/api/admin/ai-configs', { json: { type: 'fpt_marketplace', baseUrl: marketplace(), name: 'Tên mới' } });
    expect(keep.status).toBe(200);
    expect((await keep.json()).name).toBe('Tên mới');
    expect(decryptSecret((await rowFor('global', null))!.apiKeyEnc)).toBe(ADMIN_KEY);

    const change = await admin.client.put('/api/admin/ai-configs', { json: input({ apiKey: 'sk-new-key-CCCC3333' }) });
    expect((await change.json()).apiKeyHint).toBe('…3333');
    expect(decryptSecret((await rowFor('global', null))!.apiKeyEnc)).toBe('sk-new-key-CCCC3333');
    // chỉ có một cấu hình chung cho mỗi loại
    expect(await getDb().select().from(aiProviderConfigs)).toHaveLength(1);
  });

  it('tạo mới mà không có khóa → 422 trên trường apiKey', async () => {
    const res = await admin.client.put('/api/admin/ai-configs', { json: input({ apiKey: undefined }) });
    expect(res.status).toBe(422);
    expect((await res.json()).error.fields).toHaveProperty('apiKey');
  });

  it.each([
    ['địa chỉ metadata đám mây', { baseUrl: 'http://169.254.169.254/latest/meta-data' }, 'baseUrl'],
    ['scheme không phải http(s)', { baseUrl: 'ftp://example.com/v1' }, 'baseUrl'],
    ['địa chỉ không hợp lệ', { baseUrl: 'khong-phai-url' }, 'baseUrl'],
    ['model không có trong danh mục', { defaultModel: 'model-la' }, 'defaultModel'],
    ['giọng không thuộc model', { defaultModel: 'FPT.AI-VITs', defaultVoice: 'std_banmai' }, 'defaultVoice'],
    ['tốc độ ngoài khoảng', { defaultSpeed: 5 }, 'defaultSpeed'],
    ['vượt giới hạn ký tự của nhà cung cấp', { maxCharsPerRequest: 99999 }, 'maxCharsPerRequest'],
  ])('%s → 422', async (_label, over, field) => {
    const res = await admin.client.put('/api/admin/ai-configs', { json: input(over) });
    expect(res.status).toBe(422);
    expect((await res.json()).error.fields).toHaveProperty(field);
    expect(await getDb().select().from(aiProviderConfigs)).toHaveLength(0);
  });

  it('trường lạ bị từ chối (strict) → 422', async () => {
    const res = await admin.client.put('/api/admin/ai-configs', { json: input({ scope: 'user', ownerUserId: 'x' }) });
    expect(res.status).toBe(422);
  });

  it('kiểm tra kết nối: thành công lưu kết quả; thất bại trả thông báo thân thiện không lộ khóa', async () => {
    await admin.client.put('/api/admin/ai-configs', { json: input() });
    const ok = await admin.client.post('/api/admin/ai-configs/fpt_marketplace/test');
    expect(await ok.json()).toMatchObject({ ok: true });
    const list = (await (await admin.client.get('/api/admin/ai-configs')).json()) as Array<{ lastTestOk: boolean; lastTestAt: string }>;
    expect(list[0]).toMatchObject({ lastTestOk: true });
    expect(list[0]!.lastTestAt).toBeTruthy();

    // đổi địa chỉ thì kết quả kiểm tra cũ bị xóa (kiểm tra TRƯỚC khi chạy kiểm tra mới)
    await admin.client.put('/api/admin/ai-configs', { json: input({ baseUrl: marketplace('401') }) });
    const cleared = (await (await admin.client.get('/api/admin/ai-configs')).json()) as Array<{ lastTestOk: boolean | null; lastTestAt: string | null }>;
    expect(cleared[0]).toMatchObject({ lastTestOk: null, lastTestAt: null });

    const bad = await admin.client.post('/api/admin/ai-configs/fpt_marketplace/test');
    const body = await bad.json();
    expect(body.ok).toBe(false);
    expect(JSON.stringify(body)).not.toContain(ADMIN_KEY);
    const after = (await (await admin.client.get('/api/admin/ai-configs')).json()) as Array<{ lastTestOk: boolean | null }>;
    expect(after[0]!.lastTestOk).toBe(false);
  });

  it('kiểm tra kết nối khi chưa có cấu hình → 404; type lạ → 404', async () => {
    expect((await admin.client.post('/api/admin/ai-configs/fpt_marketplace/test')).status).toBe(404);
    expect((await admin.client.post('/api/admin/ai-configs/khong-co/test')).status).toBe(404);
  });

  it('xóa cấu hình: 204, lần hai 404', async () => {
    await admin.client.put('/api/admin/ai-configs', { json: input() });
    expect((await admin.client.delete('/api/admin/ai-configs/fpt_marketplace')).status).toBe(204);
    expect((await admin.client.delete('/api/admin/ai-configs/fpt_marketplace')).status).toBe(404);
  });

  it('tắt cấu hình chung ghi lý do admin_disabled; bật lại xóa lý do', async () => {
    await admin.client.put('/api/admin/ai-configs', { json: input() });
    const off = await admin.client.put('/api/admin/ai-configs', { json: input({ apiKey: undefined, enabled: false }) });
    expect(await off.json()).toMatchObject({ enabled: false, disabledReason: 'admin_disabled' });
    const on = await admin.client.put('/api/admin/ai-configs', { json: input({ apiKey: undefined, enabled: true }) });
    expect(await on.json()).toMatchObject({ enabled: true, disabledReason: null });
  });
});

describe('danh mục nhà cung cấp /api/providers', () => {
  it('liệt kê 3 loại kèm model/giọng/tốc độ; khả dụng chỉ khi có cấu hình chung đang bật', async () => {
    const u = await createUser();
    const before = (await (await u.client.get('/api/providers')).json()) as Array<{ type: string; available: boolean; usingOwnConfig: boolean; models: unknown[] }>;
    expect(before.map((p) => p.type).sort()).toEqual(['fpt_marketplace', 'openai_compatible', 'shopaikey_minimax', 'soniox']);
    expect(before.every((p) => !p.available && !p.usingOwnConfig && (p.type === 'soniox' || p.models.length > 0))).toBe(true);

    await admin.client.put('/api/admin/ai-configs', { json: input() });
    const after = (await (await u.client.get('/api/providers')).json()) as typeof before;
    expect(after.find((p) => p.type === 'fpt_marketplace')).toMatchObject({ available: true, usingOwnConfig: false });
    expect(after.find((p) => p.type === 'shopaikey_minimax')).toMatchObject({ available: false });
  });
});

describe('cấu hình riêng và danh sách User được phép', () => {
  let a: TestUser; // trong danh sách
  let b: TestUser; // không trong danh sách

  beforeEach(async () => {
    a = await createUser({ name: 'User A' });
    b = await createUser({ name: 'User B' });
  });

  const userInput = (over: Record<string, unknown> = {}) => input({ apiKey: USER_KEY, ...over });
  const allow = (u: TestUser) => admin.client.post('/api/admin/custom-ai-users', { json: { userId: u.id } });

  it('User mới mặc định KHÔNG nằm trong danh sách: không thấy và không gửi được cấu hình riêng (404)', async () => {
    expect((await b.client.get('/api/me/ai-config')).status).toBe(404);
    expect((await b.client.put('/api/me/ai-config', { json: userInput() })).status).toBe(404);
    expect((await b.client.delete('/api/me/ai-config/fpt_marketplace')).status).toBe(404);
    expect((await b.client.post('/api/me/ai-config/fpt_marketplace/test')).status).toBe(404);
    expect(await getDb().select().from(aiProviderConfigs)).toHaveLength(0);
  });

  it('Administrator thêm vào danh sách → User nhập được cấu hình riêng; danh sách có tìm kiếm', async () => {
    expect((await allow(a)).status).toBe(204);
    const list = (await (await admin.client.get('/api/admin/custom-ai-users')).json()) as Array<{ id: string }>;
    expect(list.map((x) => x.id)).toEqual([a.id]);
    expect(((await (await admin.client.get('/api/admin/custom-ai-users?q=zzzzzz')).json()) as unknown[]).length).toBe(0);

    expect(await (await a.client.get('/api/me/ai-config')).json()).toEqual([]);
    const put = await a.client.put('/api/me/ai-config', { json: userInput() });
    expect(put.status).toBe(200);
    expect(await put.clone().text()).not.toContain(USER_KEY);
    expect(await put.json()).toMatchObject({ scope: 'user', type: 'fpt_marketplace', apiKeyHint: '…2222' });
    const row = await rowFor('user', a.id);
    expect(decryptSecret(row!.apiKeyEnc)).toBe(USER_KEY);

    const prov = (await (await a.client.get('/api/providers')).json()) as Array<{ type: string; available: boolean; usingOwnConfig: boolean }>;
    expect(prov.find((p) => p.type === 'fpt_marketplace')).toMatchObject({ available: true, usingOwnConfig: true });
  });

  it('cấu hình riêng của A không lộ cho B, Administrator cũng không đọc được khóa', async () => {
    await allow(a);
    await a.client.put('/api/me/ai-config', { json: userInput() });
    await allow(b);
    expect(await (await b.client.get('/api/me/ai-config')).json()).toEqual([]);
    const adminList = await admin.client.get('/api/admin/ai-configs');
    expect(await adminList.clone().text()).not.toContain(USER_KEY);
    expect((await adminList.json()) as unknown[]).toHaveLength(0); // chỉ liệt kê cấu hình chung
  });

  it('kiểm tra kết nối của cấu hình riêng và xóa cấu hình riêng', async () => {
    await allow(a);
    await a.client.put('/api/me/ai-config', { json: userInput() });
    expect(await (await a.client.post('/api/me/ai-config/fpt_marketplace/test')).json()).toMatchObject({ ok: true });
    expect((await a.client.delete('/api/me/ai-config/fpt_marketplace')).status).toBe(204);
    expect((await a.client.delete('/api/me/ai-config/fpt_marketplace')).status).toBe(404);
  });

  it('chọn cấu hình lúc bắt đầu job: riêng nếu đủ điều kiện, ngược lại chung', async () => {
    await admin.client.put('/api/admin/ai-configs', { json: input() });
    await allow(a);
    await a.client.put('/api/me/ai-config', { json: userInput() });

    const forA = await resolveConfigForJob({ id: a.id, canUseCustomAi: true }, 'fpt_marketplace');
    expect(forA.scope).toBe('user');
    expect(decryptSecret(forA.row.apiKeyEnc)).toBe(USER_KEY);

    const forB = await resolveConfigForJob({ id: b.id, canUseCustomAi: false }, 'fpt_marketplace');
    expect(forB.scope).toBe('global');
    expect(decryptSecret(forB.row.apiKeyEnc)).toBe(ADMIN_KEY);

    // loại không có cấu hình riêng → dùng chung của loại đó
    await admin.client.put('/api/admin/ai-configs', { json: { type: 'shopaikey_openai', baseUrl: mock.url + '/s/ok', apiKey: 'sk-shop-global-0000DDDD' } });
    expect((await resolveConfigForJob({ id: a.id, canUseCustomAi: true }, 'shopaikey_openai')).scope).toBe('global');
  });

  it('không có cấu hình khả dụng (chưa tạo, hoặc cấu hình chung đang tắt) → 409 PROVIDER_NOT_CONFIGURED', async () => {
    await expect(resolveConfigForJob({ id: b.id, canUseCustomAi: false }, 'shopaikey_minimax')).rejects.toMatchObject({ status: 409, code: 'PROVIDER_NOT_CONFIGURED' });
    await admin.client.put('/api/admin/ai-configs', { json: input({ enabled: false }) });
    await expect(resolveConfigForJob({ id: b.id, canUseCustomAi: false }, 'fpt_marketplace')).rejects.toMatchObject({ code: 'PROVIDER_NOT_CONFIGURED' });
  });

  it('cấu hình riêng KHÔNG tự thay bằng cấu hình chung khi User còn trong danh sách (kể cả khi khóa riêng sai)', async () => {
    await admin.client.put('/api/admin/ai-configs', { json: input() });
    await allow(a);
    await a.client.put('/api/me/ai-config', { json: userInput({ baseUrl: marketplace('401') }) });
    const r = await resolveConfigForJob({ id: a.id, canUseCustomAi: true }, 'fpt_marketplace');
    expect(r.scope).toBe('user'); // lỗi 401 của cấu hình riêng sẽ được báo nguyên văn, không âm thầm dùng khóa chung
  });

  it('gỡ khỏi danh sách: cấu hình riêng bị vô hiệu nhưng còn nguyên; quay về cấu hình chung; User mất quyền truy cập', async () => {
    await admin.client.put('/api/admin/ai-configs', { json: input() });
    await allow(a);
    await a.client.put('/api/me/ai-config', { json: userInput() });

    expect((await admin.client.delete(`/api/admin/custom-ai-users/${a.id}`)).status).toBe(204);

    const row = await rowFor('user', a.id);
    expect(row).not.toBeNull();
    expect(row).toMatchObject({ enabled: false, disabledReason: 'owner_removed_from_list' });
    expect(decryptSecret(row!.apiKeyEnc)).toBe(USER_KEY); // giữ lại, không xóa

    expect((await a.client.get('/api/me/ai-config')).status).toBe(404);
    expect((await a.client.put('/api/me/ai-config', { json: userInput() })).status).toBe(404);
    expect((await resolveConfigForJob({ id: a.id, canUseCustomAi: false }, 'fpt_marketplace')).scope).toBe('global');
    const prov = (await (await a.client.get('/api/providers')).json()) as Array<{ type: string; usingOwnConfig: boolean }>;
    expect(prov.find((p) => p.type === 'fpt_marketplace')!.usingOwnConfig).toBe(false);

    // thêm lại: cấu hình vẫn bị vô hiệu cho đến khi User lưu lại
    await allow(a);
    expect((await rowFor('user', a.id))!.enabled).toBe(false);
    expect((await resolveConfigForJob({ id: a.id, canUseCustomAi: true }, 'fpt_marketplace')).scope).toBe('global');
    const reenable = await a.client.put('/api/me/ai-config', { json: userInput({ apiKey: undefined }) });
    expect(await reenable.json()).toMatchObject({ enabled: true, disabledReason: null });
    expect((await resolveConfigForJob({ id: a.id, canUseCustomAi: true }, 'fpt_marketplace')).scope).toBe('user');
  });

  it('tắt quyền qua PATCH /api/admin/users cũng vô hiệu cấu hình riêng (hai đường nhất quán)', async () => {
    await allow(a);
    await a.client.put('/api/me/ai-config', { json: userInput() });
    const res = await admin.client.patch(`/api/admin/users/${a.id}`, { json: { canUseCustomAi: false } });
    expect(res.status).toBe(200);
    expect(await rowFor('user', a.id)).toMatchObject({ enabled: false, disabledReason: 'owner_removed_from_list' });
  });

  it('chỉ thêm được User thật; id sai → 404/422', async () => {
    expect((await admin.client.post('/api/admin/custom-ai-users', { json: { userId: 'khong-phai-uuid' } })).status).toBe(422);
    expect((await admin.client.post('/api/admin/custom-ai-users', { json: { userId: '00000000-0000-4000-8000-000000000000' } })).status).toBe(404);
    expect((await admin.client.delete('/api/admin/custom-ai-users/00000000-0000-4000-8000-000000000000')).status).toBe(404);
  });

  it('User thường không gọi được các endpoint quản trị cấu hình AI (404)', async () => {
    const c: TestClient = b.client;
    expect((await c.get('/api/admin/ai-configs')).status).toBe(404);
    expect((await c.put('/api/admin/ai-configs', { json: input() })).status).toBe(404);
    expect((await c.get('/api/admin/custom-ai-users')).status).toBe(404);
    expect((await c.post('/api/admin/custom-ai-users', { json: { userId: b.id } })).status).toBe(404);
    const [self] = await getDb().select().from(aiProviderConfigs).where(and(eq(aiProviderConfigs.scope, 'global')));
    expect(self).toBeUndefined();
  });
});
