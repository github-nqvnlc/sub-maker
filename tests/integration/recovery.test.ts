import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startMockProvider, type MockProvider } from '../../mock-provider/server';
import { getDb } from '@/lib/db';
import { aiProviderConfigs, voiceJobs } from '@/lib/db/schema';
import { runGenerateVoice } from '@/worker/jobs/generate-voice';
import { sweepStaleJobs } from '@/worker/sweeper';
import { stopBoss } from '@/worker/queues';
import { clearRateLimits, createAdmin, createUser, resetDb, type TestUser } from './helpers';
import { FAST, SCRIPT_4, jobRow, logCodes, newProject, postCount, putGlobalConfig, segmentRows, setScenario, startJob, uploadScript, usageRows, voiceOfJob } from './voice-helpers';

let mock: MockProvider;
let admin: TestUser;
let user: TestUser;

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
  user = await createUser({ name: 'Người dùng phục hồi' });
});

/** Tạo job rồi cho chạy tới giữa chừng (2 đoạn đầu xong, đoạn 3 lỗi) để có trạng thái dở dang thật. */
async function halfDoneJob() {
  await setScenario(admin, mock, 'ok-then-5xx-2');
  const pid = await newProject(user);
  const file = await uploadScript(user, pid, SCRIPT_4);
  const job = await startJob(user, pid, file.id);
  await runGenerateVoice(job.id, { ...FAST, retry: { maxAttempts: 1, baseMs: 1, maxMs: 1 }, segmentConcurrency: 1 });
  expect((await jobRow(job.id)).progressDone).toBe(2);
  await setScenario(admin, mock, 'ok');
  mock.reset();
  return job;
}

/** Mô phỏng worker chết giữa chừng: job ở `running` với heartbeat cũ. */
async function simulateCrash(jobId: string, ageSeconds = 120) {
  await getDb()
    .update(voiceJobs)
    .set({ status: 'running', errorCode: null, errorMessage: null, finishedAt: null, heartbeatAt: sql`now() - (${ageSeconds} * interval '1 second')` })
    .where(eq(voiceJobs.id, jobId));
}

describe('phục hồi sau khi worker chết (Nguyên tắc III, SC-003)', () => {
  it('quét job treo → interrupted + xếp hàng lại → tiếp tục từ đoạn chưa xong, không gọi lại đoạn đã xong', async () => {
    const job = await halfDoneJob();
    await simulateCrash(job.id);

    const requeued: string[] = [];
    const swept = await sweepStaleJobs({ staleMs: 30_000, requeue: async (id) => void requeued.push(id) });
    expect(swept.interrupted).toEqual([job.id]);
    expect(requeued).toEqual([job.id]);
    expect((await jobRow(job.id)).status).toBe('interrupted');
    expect(await logCodes(job.id)).toContain('JOB_INTERRUPTED');

    // worker mới nhận job bị gián đoạn
    await runGenerateVoice(job.id, { ...FAST, segmentConcurrency: 1 });

    const j = await jobRow(job.id);
    expect(j).toMatchObject({ status: 'completed', progressDone: 4, errorCode: null });
    expect(postCount(mock)).toBe(2); // chỉ 2 đoạn còn lại
    const codes = await logCodes(job.id);
    expect(codes).toContain('JOB_RESUMED');
    expect(codes).toContain('SEGMENTS_SKIPPED');
    expect((await usageRows(job.id)).filter((u) => u.ok)).toHaveLength(4); // không lặp
    expect((await voiceOfJob(job.id))!.timeline).toHaveLength(4);
    expect((await segmentRows(job.id)).every((s) => s.status === 'done')).toBe(true);
  });

  it('job còn heartbeat mới (worker khỏe) KHÔNG bị coi là treo', async () => {
    const job = await halfDoneJob();
    await simulateCrash(job.id, 2); // heartbeat 2 giây trước
    const swept = await sweepStaleJobs({ staleMs: 30_000, requeue: async () => undefined });
    expect(swept.interrupted).toEqual([]);
    expect((await jobRow(job.id)).status).toBe('running');
  });

  it('heartbeat rỗng cũng bị coi là treo', async () => {
    const job = await halfDoneJob();
    await getDb().update(voiceJobs).set({ status: 'running', heartbeatAt: null }).where(eq(voiceJobs.id, job.id));
    const swept = await sweepStaleJobs({ staleMs: 30_000, requeue: async () => undefined });
    expect(swept.interrupted).toEqual([job.id]);
  });

  it('người dùng đã yêu cầu dừng trước khi worker chết → stopped, KHÔNG chạy lại', async () => {
    const job = await halfDoneJob();
    await simulateCrash(job.id);
    await getDb().update(voiceJobs).set({ cancelRequested: true }).where(eq(voiceJobs.id, job.id));
    const requeued: string[] = [];
    const swept = await sweepStaleJobs({ staleMs: 30_000, requeue: async (id) => void requeued.push(id) });
    expect(swept.stopped).toEqual([job.id]);
    expect(requeued).toEqual([]);
    expect(await jobRow(job.id)).toMatchObject({ status: 'stopped', cancelRequested: false });
  });

  it('quét lặp lại là idempotent: job đã interrupted không bị xếp hàng lần hai', async () => {
    const job = await halfDoneJob();
    await simulateCrash(job.id);
    const requeued: string[] = [];
    const requeue = async (id: string) => void requeued.push(id);
    await sweepStaleJobs({ staleMs: 30_000, requeue });
    await sweepStaleJobs({ staleMs: 30_000, requeue });
    expect(requeued).toEqual([job.id]);
  });

  it('hai worker cùng nhận một job: chỉ một chạy (nhận nguyên tử)', async () => {
    const pid = await newProject(user);
    const job = await startJob(user, pid, (await uploadScript(user, pid, SCRIPT_4)).id);
    await Promise.all([runGenerateVoice(job.id, FAST), runGenerateVoice(job.id, FAST)]);
    expect((await jobRow(job.id)).status).toBe('completed');
    expect(postCount(mock)).toBe(4); // mỗi đoạn đúng một lần, không bị chạy đôi
    expect((await usageRows(job.id)).filter((u) => u.ok)).toHaveLength(4);
  });
});
