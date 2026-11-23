import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startMockProvider, type MockProvider } from '../../mock-provider/server';
import { getDb } from '@/lib/db';
import { customAiProviders, voiceJobs } from '@/lib/db/schema';
import { decryptSecret } from '@/lib/security/crypto';
import { stopBoss } from '@/worker/queues';
import { clearRateLimits, createAdmin, createUser, resetDb, type TestUser } from './helpers';
import { newProject, uploadScript } from './voice-helpers';

/** CRUD Custom Provider chuẩn OpenAI + phân quyền (spec 004, US5, T019). */
let mock: MockProvider;
let admin: TestUser;

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
  await getDb().delete(voiceJobs);
  await getDb().delete(customAiProviders);
});

const KEY = 'sk-deepseek-secret-7777';
const body = (over: Record<string, unknown> = {}) => ({
  name: 'DeepSeek',
  baseUrl: `${mock.url}/s/ok/v1`,
  apiKey: KEY,
  models: ['tts-1', 'tts-1'],
  defaultModel: 'tts-1',
  defaultVoice: 'alloy',
  accessMode: 'public',
  ...over,
});
type Dto = { id: string; apiKeyHint: string; models: string[]; accessMode: string; assignedUserIds: string[] };

async function create(over: Record<string, unknown> = {}): Promise<Dto> {
  const res = await admin.client.post('/api/admin/custom-ai-providers', { json: body(over) });
  if (res.status !== 201) throw new Error(`${res.status} ${await res.text()}`);
  return (await res.json()) as Dto;
}

const visibleTo = async (u: TestUser) => ((await (await u.client.get('/api/me/ai-providers')).json()) as Array<{ id: string }>).map((p) => p.id);

describe('CRUD', () => {
  it('tạo (khóa mã hóa, chỉ trả dạng che), liệt kê, sửa, kiểm tra kết nối, xóa', async () => {
    const p = await create();
    expect(JSON.stringify(p)).not.toContain(KEY);
    expect(p.models).toEqual(['tts-1']); // bỏ trùng
    const [row] = await getDb().select().from(customAiProviders).where(eq(customAiProviders.id, p.id));
    expect(decryptSecret(row!.apiKeyEnc)).toBe(KEY);

    const list = (await (await admin.client.get('/api/admin/custom-ai-providers')).json()) as Dto[];
    expect(list.map((x) => x.id)).toEqual([p.id]);

    const upd = await admin.client.put(`/api/admin/custom-ai-providers/${p.id}`, { json: body({ name: 'DeepSeek 2', apiKey: undefined }) });
    expect(upd.status).toBe(200);
    const [after] = await getDb().select().from(customAiProviders).where(eq(customAiProviders.id, p.id));
    expect(after).toMatchObject({ name: 'DeepSeek 2' });
    expect(decryptSecret(after!.apiKeyEnc)).toBe(KEY); // không nhập khóa = giữ khóa cũ

    const test = await admin.client.post(`/api/admin/custom-ai-providers/${p.id}/test`);
    expect(test.status).toBe(200);

    expect((await admin.client.delete(`/api/admin/custom-ai-providers/${p.id}`)).status).toBe(200);
    expect(await getDb().select().from(customAiProviders)).toHaveLength(0);
  });

  it('User thường không dùng được API quản trị (404)', async () => {
    const u = await createUser();
    expect((await u.client.get('/api/admin/custom-ai-providers')).status).toBe(404);
    expect((await u.client.post('/api/admin/custom-ai-providers', { json: body() })).status).toBe(404);
  });

  it('thiếu khóa khi tạo → 422', async () => {
    const res = await admin.client.post('/api/admin/custom-ai-providers', { json: body({ apiKey: undefined }) });
    expect(res.status).toBe(422);
  });
});

describe('phân quyền (Independent Test US5)', () => {
  it('Chỉ định User A: A thấy, B không thấy; Công khai: mọi User; Chỉ Admin: User không thấy; tắt: không ai thấy', async () => {
    const a = await createUser({ name: 'A' });
    const b = await createUser({ name: 'B' });
    const restricted = await create({ name: 'Chỉ A', accessMode: 'restricted', assignedUserIds: [a.id] });
    const pub = await create({ name: 'Công khai' });
    const priv = await create({ name: 'Admin', accessMode: 'private' });

    expect((await visibleTo(a)).sort()).toEqual([restricted.id, pub.id].sort());
    expect(await visibleTo(b)).toEqual([pub.id]);
    expect((await visibleTo(admin)).sort()).toEqual([restricted.id, pub.id, priv.id].sort());

    await admin.client.put(`/api/admin/custom-ai-providers/${pub.id}`, { json: body({ name: 'Công khai', apiKey: undefined, enabled: false }) });
    expect(await visibleTo(b)).toEqual([]);
  });

  it('danh sách cho User không chứa khóa, địa chỉ hay danh sách User', async () => {
    const a = await createUser();
    await create({ accessMode: 'restricted', assignedUserIds: [a.id] });
    const text = await (await a.client.get('/api/me/ai-providers')).text();
    expect(text).not.toContain(KEY);
    expect(text).not.toContain(mock.url);
    expect(text).not.toContain(a.id);
  });
});

describe('xóa/tắt khi còn job (US5-AS4)', () => {
  async function jobsFor(providerId: string) {
    const u = await createUser();
    const projectId = await newProject(u, 'P', 'openai_compatible');
    const file = await uploadScript(u, projectId, 'Xin chào.');
    const mk = async (status: 'queued' | 'interrupted' | 'running') => {
      const [r] = await getDb()
        .insert(voiceJobs)
        .values({ projectId, ownerId: u.id, subtitleFileId: file.id, status, providerType: 'openai_compatible', customProviderId: providerId, configScope: 'global', settings: { voice: 'alloy', customProviderId: providerId } })
        .returning();
      return r!.id;
    };
    return { queued: await mk('queued'), interrupted: await mk('interrupted'), running: await mk('running') };
  }
  const status = async (id: string) => (await getDb().select().from(voiceJobs).where(eq(voiceJobs.id, id)))[0]!;

  it('xóa: job chưa bắt đầu → failed "Nhà cung cấp đã bị xóa hoặc tắt"; job đang chạy không bị động tới', async () => {
    const p = await create();
    const j = await jobsFor(p.id);
    const pending = (await (await admin.client.get(`/api/admin/custom-ai-providers/${p.id}`)).json()) as { pendingJobs: number };
    expect(pending.pendingJobs).toBe(2);
    const del = (await (await admin.client.delete(`/api/admin/custom-ai-providers/${p.id}`)).json()) as { cancelledJobs: number };
    expect(del.cancelledJobs).toBe(2);
    expect(await status(j.queued)).toMatchObject({ status: 'failed', errorCode: 'CUSTOM_PROVIDER_UNAVAILABLE', errorMessage: 'Nhà cung cấp đã bị xóa hoặc tắt.' });
    expect(await status(j.interrupted)).toMatchObject({ status: 'failed' });
    expect(await status(j.running)).toMatchObject({ status: 'running' });
  });

  it('tắt: xử lý như xóa', async () => {
    const p = await create();
    const j = await jobsFor(p.id);
    const res = (await (await admin.client.put(`/api/admin/custom-ai-providers/${p.id}`, { json: body({ apiKey: undefined, enabled: false }) })).json()) as { cancelledJobs: number };
    expect(res.cancelledJobs).toBe(2);
    expect(await status(j.queued)).toMatchObject({ status: 'failed', errorCode: 'CUSTOM_PROVIDER_UNAVAILABLE' });
    expect(await status(j.running)).toMatchObject({ status: 'running' });
  });
});
