import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { expectedDurationMs, startMockProvider, type MockProvider } from '../../mock-provider/server';
import { getDb } from '@/lib/db';
import { aiProviderConfigs } from '@/lib/db/schema';
import { runGenerateVoice } from '@/worker/jobs/generate-voice';
import { stopBoss } from '@/worker/queues';
import { clearRateLimits, createAdmin, createUser, resetDb, type TestUser } from './helpers';
import { FAST, GLOBAL_KEY, SCRIPT_4, jobRow, logCodes, newProject, putGlobalConfig, segmentRows, startJob, uploadScript, usageRows, voiceOfJob } from './voice-helpers';

/** Nhà cung cấp ShopAIKey MiniMax chạy trọn đường: cấu hình chung → Project → job → worker → voice + usage. */
let mock: MockProvider;
let admin: TestUser;
let user: TestUser;

const LINES = SCRIPT_4.split('\n');
const minimaxConfig = (scenario: string) => ({
  type: 'shopaikey_minimax',
  baseUrl: `${mock.url}/s/${scenario}`,
  defaultModel: 'speech-02-hd',
  defaultVoice: 'Vietnamese_female_4_v1',
});

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
  user = await createUser();
});

async function run(scenario: string, over: Record<string, unknown> = {}) {
  await putGlobalConfig(admin, mock, 'ok', { ...minimaxConfig(scenario), pricePerMillionChars: 1_000_000, ...over });
  const projectId = await newProject(user, 'Dự án MiniMax', 'shopaikey_minimax');
  const file = await uploadScript(user, projectId, SCRIPT_4);
  const job = await startJob(user, projectId, file.id);
  await runGenerateVoice(job.id, { ...FAST, segmentConcurrency: 1 });
  return { projectId, job };
}

describe('ShopAIKey MiniMax: tạo voice trọn đường', () => {
  it('thành công: voice đúng timeline, usage ghi đúng nhà cung cấp/ký tự/chi phí, không lộ khóa', async () => {
    const { job } = await run('ok');
    expect(await jobRow(job.id)).toMatchObject({ status: 'completed', progressDone: 4, progressTotal: 4, providerType: 'shopaikey_minimax' });

    const voice = await voiceOfJob(job.id);
    expect(voice).not.toBeNull();
    expect(voice!.timeline).toHaveLength(4);
    expect(voice!.timeline[0]!.endMs - voice!.timeline[0]!.startMs).toBe(expectedDurationMs(LINES[0]!));

    const usage = await usageRows(job.id);
    expect(usage).toHaveLength(4);
    expect(usage.every((u) => u.ok && u.providerType === 'shopaikey_minimax' && u.configScope === 'global')).toBe(true);
    expect(usage.map((u) => u.unitsChars).sort()).toEqual(LINES.map((l) => [...l].length).sort());
    expect(usage.every((u) => u.unitsTokens === null)).toBe(true);

    const sent = mock.requests.filter((r) => r.method === 'POST');
    expect(sent).toHaveLength(4);
    expect(sent[0]!.path).toBe('/s/ok/tts/minimax/t2a_v2');
    expect(sent[0]!.headers['authorization']).toBe(`Bearer ${GLOBAL_KEY}`);
    expect(JSON.parse(sent[0]!.body).voice_setting.voice_id).toBe('Vietnamese_female_4_v1');

    expect(JSON.stringify([await usageRows(job.id), await jobRow(job.id), await segmentRows(job.id)])).not.toContain(GLOBAL_KEY);
  });

  it('lỗi nghiệp vụ trong base_resp (hết số dư 1008) → job failed QUOTA ngay, chỉ 1 lần gọi, không thử lại', async () => {
    const { job } = await run('mm-1008');
    expect(await jobRow(job.id)).toMatchObject({ status: 'failed', errorCode: 'QUOTA' });
    expect(mock.requests.filter((r) => r.method === 'POST')).toHaveLength(1);
    const codes = await logCodes(job.id);
    expect(codes).not.toContain('RETRY');
    expect(codes).toContain('JOB_FAILED');
    expect(await voiceOfJob(job.id)).toBeNull();
  });

  it('giới hạn tốc độ (1002) được thử lại tới hết số lần rồi mới báo lỗi tạm thời', async () => {
    const { job } = await run('mm-1002');
    expect(await jobRow(job.id)).toMatchObject({ status: 'failed', errorCode: 'TRANSIENT' });
    expect(mock.requests.filter((r) => r.method === 'POST')).toHaveLength(3); // FAST.retry.maxAttempts
    expect((await logCodes(job.id)).filter((c) => c === 'RETRY').length).toBeGreaterThan(0);
  });
});
