import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '@/lib/db';
import { aiProviderConfigs } from '@/lib/db/schema';
import { runGenerateVoice } from '@/worker/jobs/generate-voice';
import { stopBoss } from '@/worker/queues';
import { clearRateLimits, createAdmin, createUser, resetDb, type TestUser } from './helpers';
import { jobRow, logCodes, newProject, startJob, uploadScript, usageRows, voiceOfJob } from './voice-helpers';

/**
 * Chạy trọn đường (hệ thống thật → nhà cung cấp THẬT) cho từng nhà cung cấp có khóa. TỐN PHÍ nhỏ nên mặc định bị bỏ qua.
 * Bật bằng:  REAL_PROVIDER_TESTS=1  và các khóa SPIKE_* (xem docs/provider-spikes.md). Ví dụ (PowerShell):
 *   $env:REAL_PROVIDER_TESTS=1; node --env-file=.env node_modules/vitest/vitest.mjs run --project integration tests/integration/real-providers.test.ts
 */
const enabled = process.env.REAL_PROVIDER_TESTS === '1';

const TARGETS = [
  { type: 'fpt_marketplace', keyEnv: 'SPIKE_FPT_MARKETPLACE_KEY', baseUrl: 'https://mkp-api.fptcloud.com/v1', model: 'FPT.AI-VITs', voice: 'banmai' },
  { type: 'shopaikey_minimax', keyEnv: 'SPIKE_SHOPAIKEY_KEY', baseUrl: 'https://api.shopaikey.com', model: 'speech-02-hd', voice: 'Vietnamese_female_4_v1' },
] as const;

const SCRIPT = ['Xin chào các bạn.', 'Hôm nay chúng ta cùng tìm hiểu lịch sử.', 'Cảm ơn đã theo dõi.'].join('\n');

let admin: TestUser;
let user: TestUser;

beforeAll(async () => {
  if (!enabled) return;
  await resetDb();
  admin = await createAdmin();
});
afterAll(async () => {
  await stopBoss();
});
beforeEach(async () => {
  if (!enabled) return;
  await clearRateLimits();
  await getDb().delete(aiProviderConfigs);
  user = await createUser();
});

describe.skipIf(!enabled)('nhà cung cấp thật (tốn phí nhỏ)', () => {
  for (const t of TARGETS) {
    it.skipIf(!process.env[t.keyEnv])(`${t.type}: tạo voice 3 đoạn tới khi hoàn tất`, async () => {
      const put = await admin.client.put('/api/admin/ai-configs', {
        json: { type: t.type, baseUrl: t.baseUrl, apiKey: process.env[t.keyEnv], defaultModel: t.model, defaultVoice: t.voice },
      });
      expect(put.ok, `cấu hình: ${put.status}`).toBe(true);

      const projectId = await newProject(user, `Thật ${t.type}`, t.type);
      const file = await uploadScript(user, projectId, SCRIPT);
      const job = await startJob(user, projectId, file.id);
      await runGenerateVoice(job.id);

      const j = await jobRow(job.id);
      expect(j, `job: ${j.status} ${j.errorCode ?? ''} ${j.errorMessage ?? ''}; log: ${(await logCodes(job.id)).join(',')}`).toMatchObject({ status: 'completed', progressDone: 3 });
      const voice = await voiceOfJob(job.id);
      expect(voice!.durationMs).toBeGreaterThan(3000);
      expect(voice!.timeline).toHaveLength(3);
      const usage = await usageRows(job.id);
      expect(usage).toHaveLength(3);
      expect(usage.every((u) => u.ok && u.providerType === t.type)).toBe(true);
    }, 120_000);
  }
});
