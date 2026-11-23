import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startMockProvider, type MockProvider } from '../../mock-provider/server';
import { getDb } from '@/lib/db';
import { customAiProviders, voiceJobs } from '@/lib/db/schema';
import { runGenerateVoice } from '@/worker/jobs/generate-voice';
import { stopBoss } from '@/worker/queues';
import { clearRateLimits, createAdmin, createUser, resetDb, type TestUser } from './helpers';
import { FAST, jobRow, newProject, uploadScript, usageRows } from './voice-helpers';

/** Voice job dùng Custom Provider do Administrator tạo (spec 004, FR-022, T022b). */
let mock: MockProvider;
let admin: TestUser;
let a: TestUser;
let b: TestUser;
let providerId: string;
const KEY = 'sk-custom-openai-5555';

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
  await getDb().delete(voiceJobs);
  await getDb().delete(customAiProviders);
  a = await createUser({ name: 'A' });
  b = await createUser({ name: 'B' });
  const res = await admin.client.post('/api/admin/custom-ai-providers', {
    json: { name: 'OpenAI chỉ A', baseUrl: `${mock.url}/s/ok/v1`, apiKey: KEY, models: ['tts-1'], defaultModel: 'tts-1', defaultVoice: 'alloy', accessMode: 'restricted', assignedUserIds: [a.id] },
  });
  providerId = ((await res.json()) as { id: string }).id;
});

async function start(u: TestUser, over: Record<string, unknown> = {}) {
  const projectId = await newProject(u, 'Dự án OpenAI', 'openai_compatible');
  const file = await uploadScript(u, projectId, 'Xin chào các bạn.\nCảm ơn.');
  return u.client.post(`/api/projects/${projectId}/jobs`, { json: { fileId: file.id, customProviderId: providerId, ...over } });
}

describe('voice dùng Custom Provider', () => {
  it('User được chỉ định: job chạy bằng base_url/khóa của provider; usage openai_compatible/global', async () => {
    const res = await start(a);
    expect(res.status).toBe(202);
    const { id } = (await res.json()) as { id: string };
    const row = await jobRow(id);
    expect(row).toMatchObject({ customProviderId: providerId, configId: null, configScope: 'global' });
    await runGenerateVoice(id, FAST);
    expect((await jobRow(id)).status).toBe('completed');
    const posts = mock.requests.filter((r) => r.method === 'POST');
    expect(posts.length).toBeGreaterThan(0);
    expect(posts.every((r) => r.scenario === 'ok' && JSON.stringify(r.headers).includes(KEY))).toBe(true);
    const usage = await usageRows(id);
    expect(usage.every((u) => u.providerType === 'openai_compatible' && u.configScope === 'global')).toBe(true);
  });

  it('User không được chỉ định gửi thẳng customProviderId → 404', async () => {
    const res = await start(b);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('CUSTOM_PROVIDER_FORBIDDEN');
  });

  it('Project không dùng openai_compatible mà gửi customProviderId → 400', async () => {
    const projectId = await newProject(a, 'FPT');
    const file = await uploadScript(a, projectId, 'Xin chào.');
    const res = await a.client.post(`/api/projects/${projectId}/jobs`, { json: { fileId: file.id, customProviderId: providerId } });
    expect(res.status).toBe(400);
  });

  it('bị gỡ khỏi danh sách: job chưa bắt đầu → failed "Bạn không còn quyền dùng nhà cung cấp này"', async () => {
    const { id } = (await (await start(a)).json()) as { id: string };
    await getDb().update(customAiProviders).set({ assignedUserIds: [] }).where(eq(customAiProviders.id, providerId));
    await runGenerateVoice(id, FAST);
    expect(await jobRow(id)).toMatchObject({ status: 'failed', errorCode: 'CUSTOM_PROVIDER_FORBIDDEN' });
  });

  it('provider bị tắt rồi job gián đoạn chạy lại → failed "Nhà cung cấp đã bị xóa hoặc tắt"', async () => {
    const { id } = (await (await start(a)).json()) as { id: string };
    await getDb().update(voiceJobs).set({ status: 'interrupted', attempt: 1 }).where(eq(voiceJobs.id, id));
    await getDb().update(customAiProviders).set({ enabled: false }).where(eq(customAiProviders.id, providerId));
    await runGenerateVoice(id, FAST);
    expect(await jobRow(id)).toMatchObject({ status: 'failed', errorCode: 'CUSTOM_PROVIDER_UNAVAILABLE' });
  });

  it('provider bị xóa (FK thành NULL) rồi job chạy lại → failed, không rơi về cấu hình khác', async () => {
    const { id } = (await (await start(a)).json()) as { id: string };
    await getDb().update(voiceJobs).set({ status: 'interrupted', attempt: 1 }).where(eq(voiceJobs.id, id));
    await getDb().delete(customAiProviders).where(eq(customAiProviders.id, providerId));
    await runGenerateVoice(id, FAST);
    expect(await jobRow(id)).toMatchObject({ status: 'failed', errorCode: 'CUSTOM_PROVIDER_UNAVAILABLE', customProviderId: null });
  });
});
