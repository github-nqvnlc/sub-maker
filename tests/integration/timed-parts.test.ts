import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startMockProvider, type MockProvider } from '../../mock-provider/server';
import { getDb } from '@/lib/db';
import { aiProviderConfigs } from '@/lib/db/schema';
import { runGenerateVoice } from '@/worker/jobs/generate-voice';
import { stopBoss } from '@/worker/queues';
import { clearRateLimits, createAdmin, createUser, resetDb, type TestUser } from './helpers';
import { FAST, jobRow, logRows, newProject, postCount, putGlobalConfig, segmentRows, setScenario, startJob, uploadScript, voiceOfJob } from './voice-helpers';

const fixture = (name: string) => fs.readFileSync(path.resolve(process.cwd(), 'tests/fixtures', name), 'utf8');
const TIMED = { timing: { mode: 'timed', mergeCues: false } };
/** Cửa sổ nhỏ chỉ dùng khi kiểm thử để phụ đề 10 giây tạo ra nhiều phần (cài đặt thật tối thiểu 1 phút). */
const PARTS = { ...FAST, partWindowMs: 3000 };

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
  user = await createUser({ name: 'Người phụ đề dài' });
});

async function prepare() {
  const projectId = await newProject(user);
  const file = await uploadScript(user, projectId, fixture('sample-synthetic.srt'), 'sample-synthetic.srt');
  const job = await startJob(user, projectId, file.id, TIMED);
  return { projectId, file, job };
}
const partLogs = async (jobId: string) => (await logRows(jobId)).filter((l) => l.code === 'PART_STARTED' || l.code === 'PART_DONE');

describe('chia phần cho phụ đề dài (spec 003, US2)', () => {
  it('chia thành nhiều phần, log theo phần, voice vẫn là MỘT tệp liền mạch đúng mốc', async () => {
    const { job } = await prepare();
    await runGenerateVoice(job.id, PARTS);
    expect((await jobRow(job.id)).status).toBe('completed');

    const logs = await partLogs(job.id);
    const started = logs.filter((l) => l.code === 'PART_STARTED');
    const done = logs.filter((l) => l.code === 'PART_DONE');
    expect(started.length).toBeGreaterThanOrEqual(3);
    expect(done).toHaveLength(started.length);
    expect((await logRows(job.id)).some((l) => l.code === 'PARTS_PLANNED')).toBe(true);

    const voice = (await voiceOfJob(job.id))!;
    expect(voice.timeline).toHaveLength(11); // 12 cue, 1 cue ♪ im lặng, mỗi cue một đơn vị
    // mốc bắt đầu vẫn bám phụ đề ở đầu, giữa và cuối (không trôi qua các phần)
    const starts = new Map(voice.timeline.map((t) => [t.text, t.startMs]));
    expect(Math.abs(starts.get('Xin chào các bạn,')! - 0)).toBeLessThanOrEqual(150);
    expect(Math.abs(starts.get('Mời bạn nghe tiếp.')! - 5600)).toBeLessThanOrEqual(150);
    expect(Math.abs(starts.get('Hẹn gặp lại.')! - 9700)).toBeLessThanOrEqual(150);
    for (let i = 1; i < voice.timeline.length; i++) expect(voice.timeline[i]!.startMs).toBeGreaterThanOrEqual(voice.timeline[i - 1]!.endMs);
  });

  it('GET /api/jobs/{id}: timing.parts {done,total} đủ khi hoàn tất', async () => {
    const { job } = await prepare();
    // Cửa sổ nhỏ chỉ dùng cho kiểm thử worker; API tính theo cài đặt job (10 phút) nên chỉ có một phần
    await runGenerateVoice(job.id, PARTS);
    const jd = await (await user.client.get(`/api/jobs/${job.id}`)).json();
    expect(jd.timing).toMatchObject({ mode: 'timed', mergeCues: false, parts: { done: 1, total: 1 } });
  });

  it('dừng giữa chừng rồi tiếp tục: 100% đơn vị đã xong được dùng lại, chỉ gọi nhà cung cấp cho phần còn lại', async () => {
    await setScenario(admin, mock, 'ok-then-5xx-4');
    const { job } = await prepare();
    await runGenerateVoice(job.id, PARTS);
    expect((await jobRow(job.id)).status).toBe('failed');
    const doneBefore = (await segmentRows(job.id)).filter((s) => s.status === 'done').length;
    expect(doneBefore).toBe(4);

    await setScenario(admin, mock, 'ok');
    mock.reset();
    expect((await user.client.post(`/api/jobs/${job.id}/resume`, { json: {} })).status).toBeLessThan(300);
    await runGenerateVoice(job.id, PARTS);
    expect((await jobRow(job.id)).status).toBe('completed');
    expect(postCount(mock)).toBe(11 - doneBefore);
    const logs = await partLogs(job.id);
    expect(logs.some((l) => l.code === 'PART_DONE')).toBe(true);
  });

  it('nhà cung cấp trả 429 vài lần: chờ rồi tiếp tục, tiến trình không thất bại', async () => {
    await setScenario(admin, mock, '429-3');
    const { job } = await prepare();
    await runGenerateVoice(job.id, PARTS);
    expect((await jobRow(job.id)).status).toBe('completed');
    expect(await voiceOfJob(job.id)).not.toBeNull();
  });

  it('phụ đề không chia phần (một phần) không sinh log theo phần', async () => {
    const { job } = await prepare();
    await runGenerateVoice(job.id, FAST); // cửa sổ mặc định 10 phút ≥ 10 giây → một phần
    expect((await jobRow(job.id)).status).toBe('completed');
    expect(await partLogs(job.id)).toHaveLength(0);
  });
});
