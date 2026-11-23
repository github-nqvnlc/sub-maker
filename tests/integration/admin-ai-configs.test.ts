import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startMockProvider, type MockProvider } from '../../mock-provider/server';
import { getDb } from '@/lib/db';
import { aiProviderConfigs, sttProviderConfigs } from '@/lib/db/schema';
import { decryptSecret } from '@/lib/security/crypto';
import { runGenerateVoice } from '@/worker/jobs/generate-voice';
import { runTranscribeMedia } from '@/worker/jobs/transcribe-media';
import { stopBoss } from '@/worker/queues';
import { startSonioxMock, type SonioxMock } from '../mocks/soniox-mock';
import { clearRateLimits, createAdmin, createUser, resetDb, type TestUser } from './helpers';
import { FAST, GLOBAL_KEY, jobRow, newProject, putGlobalConfig, startJob, uploadScript } from './voice-helpers';
import { createSttJobApi, FAST_STT, putSonioxConfig, SONIOX_KEY, sttJobRow } from './stt-helpers';

/** Cấu hình AI chung 1 token: FPT.AI, SONIOX, ShopAIKey (spec 004, US4, T012). */
let tts: MockProvider;
let soniox: SonioxMock;
let admin: TestUser;

beforeAll(async () => {
  tts = await startMockProvider();
  soniox = await startSonioxMock();
  await resetDb();
  admin = await createAdmin();
});
afterAll(async () => {
  await tts.close();
  await soniox.close();
  await stopBoss();
});
beforeEach(async () => {
  await clearRateLimits();
  tts.reset();
  soniox.reset();
  await getDb().delete(aiProviderConfigs);
  await getDb().delete(sttProviderConfigs);
});

describe('SONIOX', () => {
  it('lưu 1 token (mã hóa), chỉ trả dạng che; mặc định stt-async-v6; kiểm tra kết nối', async () => {
    const dto = (await putSonioxConfig(admin, soniox)) as Record<string, unknown>;
    expect(dto).toMatchObject({ provider: 'soniox', defaultModel: 'stt-async-v6', enabled: true });
    expect(JSON.stringify(dto)).not.toContain(SONIOX_KEY);
    const [row] = await getDb().select().from(sttProviderConfigs);
    expect(decryptSecret(row!.apiKeyEnc)).toBe(SONIOX_KEY);
    const test = await admin.client.post('/api/admin/stt-config/test');
    expect(await test.json()).toMatchObject({ ok: true });
    expect(soniox.requests.at(-1)).toMatchObject({ path: '/v1/models', auth: `Bearer ${SONIOX_KEY}` });
  });

  it('model real-time không được làm mặc định (422); sửa không nhập khóa = giữ khóa cũ', async () => {
    await putSonioxConfig(admin, soniox);
    const bad = await admin.client.put('/api/admin/stt-config', { json: { defaultModel: 'stt-rt-v6' } });
    expect(bad.status).toBe(422);
    const ok = await admin.client.put('/api/admin/stt-config', { json: { defaultModel: 'stt-async-v5', pricePerAudioHourUsd: 0.1 } });
    expect(ok.status).toBe(200);
    const [row] = await getDb().select().from(sttProviderConfigs);
    expect(row).toMatchObject({ defaultModel: 'stt-async-v5', pricePerAudioHourUsd: 0.1 });
    expect(decryptSecret(row!.apiKeyEnc)).toBe(SONIOX_KEY);
  });

  it('User thường không đọc/ghi được (404)', async () => {
    const u = await createUser();
    expect((await u.client.get('/api/admin/stt-config')).status).toBe(404);
    expect((await u.client.post('/api/admin/stt-config/test')).status).toBe(404);
  });
});

describe('ShopAIKey', () => {
  it('1 token dùng cho cả OpenAI TTS và MiniMax; xóa là xóa cả hai', async () => {
    const res = await admin.client.put('/api/admin/ai-configs', { json: { type: 'shopaikey_openai', baseUrl: `${tts.url}/s/ok`, apiKey: 'sk-shop-one-token-1111' } });
    expect(res.status).toBe(200);
    const rows = await getDb().select().from(aiProviderConfigs).where(eq(aiProviderConfigs.scope, 'global'));
    expect(rows.map((r) => r.type).sort()).toEqual(['shopaikey_minimax', 'shopaikey_openai']);
    expect(rows.every((r) => decryptSecret(r.apiKeyEnc) === 'sk-shop-one-token-1111' && r.baseUrl === `${tts.url}/s/ok`)).toBe(true);

    await admin.client.put('/api/admin/ai-configs', { json: { type: 'shopaikey_minimax', baseUrl: `${tts.url}/s/ok`, apiKey: 'sk-shop-rotated-2222' } });
    const after = await getDb().select().from(aiProviderConfigs).where(eq(aiProviderConfigs.scope, 'global'));
    expect(after.every((r) => decryptSecret(r.apiKeyEnc) === 'sk-shop-rotated-2222')).toBe(true);

    expect((await admin.client.delete('/api/admin/ai-configs/shopaikey_openai')).status).toBeLessThan(300);
    expect(await getDb().select().from(aiProviderConfigs).where(eq(aiProviderConfigs.scope, 'global'))).toHaveLength(0);
  });
});

describe('OpenAI dùng chung', () => {
  it('không tạo được ở cấu hình chung nữa (đã chuyển sang Custom Provider)', async () => {
    const res = await admin.client.put('/api/admin/ai-configs', { json: { type: 'openai_compatible', baseUrl: `${tts.url}/s/ok`, apiKey: 'sk-x' } });
    expect(res.status).toBe(422);
    expect(await getDb().select().from(aiProviderConfigs).where(and(eq(aiProviderConfigs.scope, 'global'), eq(aiProviderConfigs.type, 'openai_compatible')))).toHaveLength(0);
  });
});

describe('Independent Test US4: mỗi luồng dùng đúng token chung', () => {
  it('voice FPT dùng token FPT; STT dùng token Soniox', async () => {
    await putGlobalConfig(admin, tts);
    await putSonioxConfig(admin, soniox);
    const user = await createUser();
    const projectId = await newProject(user);
    const file = await uploadScript(user, projectId, 'Xin chào.\nTạm biệt.');
    for (const model of ['FPT.AI-VITs', 'FPT.TTS-pro']) {
      const voice = model === 'FPT.AI-VITs' ? 'banmai' : 'std_banmai';
      const job = await startJob(user, projectId, file.id, { model, voice });
      await runGenerateVoice(job.id, FAST);
      expect((await jobRow(job.id)).status).toBe('completed');
    }
    const ttsPosts = tts.requests.filter((r) => r.method === 'POST');
    expect(ttsPosts.length).toBeGreaterThan(0);
    expect(ttsPosts.every((r) => JSON.stringify(r.headers).includes(GLOBAL_KEY))).toBe(true);

    const stt = await createSttJobApi(user, projectId);
    await runTranscribeMedia(stt.id, FAST_STT);
    expect((await sttJobRow(stt.id))!.status).toBe('completed');
    expect(soniox.requests.every((r) => r.auth === `Bearer ${SONIOX_KEY}`)).toBe(true);
  });
});
