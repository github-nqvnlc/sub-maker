import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startMockProvider, type MockProvider } from '../../mock-provider/server';
import { getDb } from '@/lib/db';
import { aiProviderConfigs, systemSettings, voiceJobs } from '@/lib/db/schema';
import { requestStop, stopAllForUser } from '@/lib/jobs/control';
import { runGenerateVoice } from '@/worker/jobs/generate-voice';
import { stopBoss } from '@/worker/queues';
import { clearRateLimits, createAdmin, createUser, resetDb, type TestUser } from './helpers';
import { FAST, SCRIPT_4, jobRow, logCodes, newProject, postCount, putGlobalConfig, setScenario, startJob, uploadScript } from './voice-helpers';

let mock: MockProvider;
let admin: TestUser;

const setSetting = (key: string, value: number) => getDb().update(systemSettings).set({ value }).where(eq(systemSettings.key, key));
const POLL = { ...FAST, admissionPollMs: 50, segmentConcurrency: 1 };

/** Lấy mẫu số job `running` tại cùng thời điểm cho tới khi `stop()` trả true. */
async function sampleMaxRunning(stop: () => boolean, ownerId?: string): Promise<number> {
  let max = 0;
  while (!stop()) {
    const rows = await getDb().select({ owner: voiceJobs.ownerId }).from(voiceJobs).where(eq(voiceJobs.status, 'running'));
    max = Math.max(max, ownerId ? rows.filter((r) => r.owner === ownerId).length : rows.length);
    await new Promise((r) => setTimeout(r, 25));
  }
  return max;
}

async function makeJob(u: TestUser, text = SCRIPT_4) {
  const pid = await newProject(u);
  return startJob(u, pid, (await uploadScript(u, pid, text)).id);
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
  await setSetting('maxConcurrentJobs', 3);
  await setSetting('maxJobsPerUser', 2);
  await getDb().delete(aiProviderConfigs);
  await putGlobalConfig(admin, mock, 'ok');
});

describe('giới hạn đồng thời (FR-025)', () => {
  it('toàn hệ thống tối đa 1 job chạy cùng lúc: job thứ hai chờ rồi chạy sau, cả hai hoàn tất', async () => {
    await setSetting('maxConcurrentJobs', 1);
    await setScenario(admin, mock, 'delay-120');
    const a = await createUser();
    const b = await createUser();
    const j1 = await makeJob(a, 'Một đoạn duy nhất.');
    const j2 = await makeJob(b, 'Một đoạn khác nữa.');

    let done = false;
    const sampler = sampleMaxRunning(() => done);
    await Promise.all([runGenerateVoice(j1.id, POLL), runGenerateVoice(j2.id, POLL)]);
    done = true;

    expect(await sampler).toBe(1); // không bao giờ có hai job cùng chạy
    expect((await jobRow(j1.id)).status).toBe('completed');
    expect((await jobRow(j2.id)).status).toBe('completed');
    const waits = (await logCodes(j1.id)).filter((c) => c === 'JOB_WAITING').length + (await logCodes(j2.id)).filter((c) => c === 'JOB_WAITING').length;
    expect(waits).toBe(1); // đúng một job phải chờ (và chỉ ghi log một lần)
  });

  it('mỗi User tối đa 1 job: job thứ hai của cùng User chờ, nhưng User khác chạy song song', async () => {
    await setSetting('maxJobsPerUser', 1);
    await setScenario(admin, mock, 'delay-150');
    const a = await createUser();
    const b = await createUser();
    const a1 = await makeJob(a, 'Việc thứ nhất của A.');
    const a2 = await makeJob(a, 'Việc thứ hai của A.');
    const b1 = await makeJob(b, 'Việc của B.');

    let done = false;
    const samplerA = sampleMaxRunning(() => done, a.id);
    const samplerAll = sampleMaxRunning(() => done);
    await Promise.all([runGenerateVoice(a1.id, POLL), runGenerateVoice(a2.id, POLL), runGenerateVoice(b1.id, POLL)]);
    done = true;

    expect(await samplerA).toBe(1); // A không bao giờ có hai job cùng chạy
    expect(await samplerAll).toBeGreaterThanOrEqual(2); // nhưng A và B chạy song song được
    for (const j of [a1, a2, b1]) expect((await jobRow(j.id)).status).toBe('completed');
    const aWaits = (await logCodes(a1.id)).concat(await logCodes(a2.id)).filter((c) => c === 'JOB_WAITING').length;
    expect(aWaits).toBe(1);
    expect((await logCodes(b1.id)).includes('JOB_WAITING')).toBe(false);
  });

  it('thay đổi giới hạn trong cài đặt có hiệu lực ngay cho lần nhận job tiếp theo', async () => {
    await setSetting('maxConcurrentJobs', 1);
    await setScenario(admin, mock, 'delay-200');
    const a = await createUser();
    const b = await createUser();
    const j1 = await makeJob(a, 'Việc thứ nhất.');
    const j2 = await makeJob(b, 'Việc thứ hai.');
    const first = runGenerateVoice(j1.id, POLL);
    await new Promise((r) => setTimeout(r, 100));
    const second = runGenerateVoice(j2.id, POLL);
    await new Promise((r) => setTimeout(r, 100));
    expect((await jobRow(j2.id)).status).toBe('queued'); // đang chờ
    await setSetting('maxConcurrentJobs', 2); // Administrator nâng giới hạn
    await new Promise((r) => setTimeout(r, 200));
    expect((await jobRow(j2.id)).status).toBe('running'); // chạy ngay không cần chờ job đầu xong
    await Promise.all([first, second]);
  });
});

describe('dừng tiến trình (lõi, FR-021)', () => {
  it('dừng job đang chờ: chuyển stopped ngay và KHÔNG bao giờ được nhận', async () => {
    const a = await createUser();
    const j = await makeJob(a);
    const r = await requestStop(a.id, [j.id]);
    expect(r).toMatchObject({ stopped: [j.id], stopRequested: [] });
    expect((await jobRow(j.id)).status).toBe('stopped');
    await runGenerateVoice(j.id, FAST);
    expect(postCount(mock)).toBe(0);
    expect(await logCodes(j.id)).toContain('JOB_STOPPED');
  });

  it('chỉ dừng được tiến trình của chính mình (id của người khác bị bỏ qua)', async () => {
    const a = await createUser();
    const b = await createUser();
    const j = await makeJob(a);
    const r = await requestStop(b.id, [j.id]);
    expect(r).toMatchObject({ stopped: [], stopRequested: [], untouched: [j.id] });
    expect((await jobRow(j.id)).status).toBe('queued');
  });

  it('dừng job đang chờ tới lượt (bị giới hạn đồng thời): rời hàng chờ, không chạy', async () => {
    await setSetting('maxConcurrentJobs', 1);
    await setScenario(admin, mock, 'delay-300');
    const a = await createUser();
    const b = await createUser();
    const j1 = await makeJob(a, 'Việc chạy trước.');
    const j2 = await makeJob(b, 'Việc đang chờ.');
    const first = runGenerateVoice(j1.id, POLL);
    await new Promise((r) => setTimeout(r, 100));
    const second = runGenerateVoice(j2.id, POLL);
    await new Promise((r) => setTimeout(r, 120));
    await requestStop(b.id, [j2.id]);
    await Promise.all([first, second]);
    expect((await jobRow(j1.id)).status).toBe('completed');
    expect((await jobRow(j2.id)).status).toBe('stopped');
  });

  it('khóa User qua API quản trị: dừng mọi tiến trình đang chờ/chạy của họ, giữ dữ liệu', async () => {
    const a = await createUser();
    const j1 = await makeJob(a);
    const j2 = await makeJob(a);
    const res = await admin.client.patch(`/api/admin/users/${a.id}`, { json: { status: 'banned' } });
    expect(res.status).toBe(200);
    expect((await jobRow(j1.id)).status).toBe('stopped');
    expect((await jobRow(j2.id)).status).toBe('stopped');
    expect(await logCodes(j1.id)).toContain('JOB_STOPPED');
  });

  it('stopAllForUser trả đủ số liệu cho job đang chạy (đặt cờ) và đang chờ (dừng ngay)', async () => {
    const a = await createUser();
    const waiting = await makeJob(a);
    const running = await makeJob(a);
    await getDb().update(voiceJobs).set({ status: 'running', heartbeatAt: new Date() }).where(eq(voiceJobs.id, running.id));
    const r = await stopAllForUser(a.id);
    expect(r.stopped).toEqual([waiting.id]);
    expect(r.stopRequested).toEqual([running.id]);
    expect((await jobRow(running.id)).cancelRequested).toBe(true);
  });
});
