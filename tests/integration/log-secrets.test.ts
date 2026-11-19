import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startMockProvider, type MockProvider } from '../../mock-provider/server';
import { getDb } from '@/lib/db';
import { aiProviderConfigs, jobSegments, voiceJobs } from '@/lib/db/schema';
import { runGenerateVoice } from '@/worker/jobs/generate-voice';
import { stopBoss } from '@/worker/queues';
import { clearRateLimits, createAdmin, createUser, resetDb, type TestUser } from './helpers';
import { FAST, GLOBAL_KEY, logRows, newProject, putGlobalConfig, setScenario, startJob, uploadScript } from './voice-helpers';

/**
 * T154 (Nguyên tắc II/IV): khóa API và URL có tham số bí mật KHÔNG BAO GIỜ xuất hiện trong job_logs,
 * bản ghi job/đoạn, phản hồi API hay log máy chủ — kể cả khi nhà cung cấp lỗi theo mọi kiểu.
 */
let mock: MockProvider;
let admin: TestUser;
let user: TestUser;

const LEAK_PATTERNS = [/[?&](key|api[_-]?key|token|access[_-]?token|secret)=/i, /Bearer\s+\S{8,}/i, /api[_-]?key["']?\s*[:=]\s*["']?[A-Za-z0-9_-]{12,}/i];

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
  await putGlobalConfig(admin, mock, 'ok');
  user = await createUser();
});

function expectNoSecrets(label: string, haystack: string) {
  expect(haystack.includes(GLOBAL_KEY), `${label}: lộ khóa API`).toBe(false);
  expect(haystack.includes(GLOBAL_KEY.slice(0, 16)), `${label}: lộ phần đầu của khóa API`).toBe(false);
  for (const re of LEAK_PATTERNS) expect(re.test(haystack), `${label}: khớp mẫu bí mật ${re}`).toBe(false);
}

const SCENARIOS = ['ok', '401', '403-quota', '403-model', '400-voice', '400-policy', 'malformed', '5xx', 'redirect-internal', 'oversize'];

describe('không lộ bí mật ở bất kỳ đâu', () => {
  it.each(SCENARIOS)('kịch bản nhà cung cấp "%s"', async (scenario) => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
    try {
      await setScenario(admin, mock, scenario);
      const projectId = await newProject(user);
      const file = await uploadScript(user, projectId, 'Xin chào các bạn.\nHôm nay học bài mới.');
      const job = await startJob(user, projectId, file.id);
      await runGenerateVoice(job.id, { ...FAST, segmentConcurrency: 1 });

      const [jobRow] = await getDb().select().from(voiceJobs);
      const segs = await getDb().select().from(jobSegments);
      const logs = await logRows(job.id);
      expectNoSecrets('job_logs', JSON.stringify(logs.map((l) => [l.code, l.message, l.meta])));
      expectNoSecrets('voice_jobs', JSON.stringify(jobRow));
      expectNoSecrets('job_segments', JSON.stringify(segs));

      // phản hồi API mà User có thể đọc
      for (const url of [`/api/jobs/${job.id}`, `/api/jobs/${job.id}/logs`, `/api/projects/${projectId}`, '/api/jobs', '/api/providers']) {
        const res = await user.client.get(url);
        expectNoSecrets(url, await res.text());
      }

      // log máy chủ (console) trong lúc chạy
      const printed = spies.flatMap((s) => s.mock.calls.map((c) => c.map((x) => (x instanceof Error ? `${x.message}\n${x.stack}` : typeof x === 'string' ? x : JSON.stringify(x))).join(' ')));
      expectNoSecrets('console', printed.join('\n'));
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
  });

  it('API cấu hình AI không bao giờ trả khóa; chỉ trả gợi ý 4 ký tự cuối', async () => {
    for (const url of ['/api/admin/ai-configs', '/api/providers']) {
      const res = await admin.client.get(url);
      expectNoSecrets(url, await res.text());
    }
    const body = await (await admin.client.get('/api/admin/ai-configs')).json();
    expect(JSON.stringify(body)).toContain(GLOBAL_KEY.slice(-4));
  });

  it('thử kết nối với khóa sai: thông báo lỗi không lặp lại khóa', async () => {
    await setScenario(admin, mock, '401');
    const res = await admin.client.post('/api/admin/ai-configs/fpt_marketplace/test', { json: {} });
    expectNoSecrets('test-connection', await res.text());
  });
});
