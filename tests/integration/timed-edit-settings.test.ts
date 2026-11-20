import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startMockProvider, type MockProvider } from '../../mock-provider/server';
import { getDb } from '@/lib/db';
import { aiProviderConfigs } from '@/lib/db/schema';
import { runGenerateVoice } from '@/worker/jobs/generate-voice';
import { stopBoss } from '@/worker/queues';
import { clearRateLimits, createAdmin, createUser, resetDb, type TestUser } from './helpers';
import { FAST, jobRow, logCodes, newProject, postCount, putGlobalConfig, segmentRows, setScenario, startJob, uploadScript, voiceOfJob } from './voice-helpers';

const fixture = (name: string) => fs.readFileSync(path.resolve(process.cwd(), 'tests/fixtures', name), 'utf8');
const TIMED = { timing: { mode: 'timed', mergeCues: true } };

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
  user = await createUser({ name: 'Người sửa thiết lập' });
});

/** Job khớp mốc trên phụ đề tổng hợp, chạy rồi dừng ở trạng thái failed sau 3 đơn vị đầu. */
async function failedAfterThree() {
  await setScenario(admin, mock, 'ok-then-5xx-3');
  const projectId = await newProject(user);
  const file = await uploadScript(user, projectId, fixture('sample-synthetic.srt'), 'sample-synthetic.srt');
  const job = await startJob(user, projectId, file.id, TIMED);
  await runGenerateVoice(job.id, FAST);
  expect((await jobRow(job.id)).status).toBe('failed');
  return { projectId, file, job };
}
const patch = (jobId: string, body: Record<string, unknown>, u: TestUser = user) => u.client.patch(`/api/jobs/${jobId}`, { json: body });

describe('sửa thiết lập job khớp mốc (research R15)', () => {
  it('đổi "Ghép cue cùng câu" dựng lại job_segments; đơn vị trùng văn bản lấy từ cache khi tiếp tục', async () => {
    const { job } = await failedAfterThree();
    expect((await jobRow(job.id)).progressTotal).toBe(10);

    const res = await patch(job.id, { timing: { mode: 'timed', mergeCues: false } });
    expect(res.status).toBe(200);
    const after = await jobRow(job.id);
    expect(after).toMatchObject({ progressTotal: 11, progressDone: 0 });
    expect(after.settings.timing).toMatchObject({ mode: 'timed', mergeCues: false, params: { maxSlipMs: 500 } });
    const segs = await segmentRows(job.id);
    expect(segs).toHaveLength(11);
    expect(segs.every((s) => s.status === 'pending' && s.audioCacheId === null)).toBe(true);
    expect(await logCodes(job.id)).toContain('SETTINGS_CHANGED');

    await setScenario(admin, mock, 'ok');
    mock.reset();
    expect((await user.client.post(`/api/jobs/${job.id}/resume`, { json: {} })).status).toBeLessThan(300);
    await runGenerateVoice(job.id, FAST);
    expect((await jobRow(job.id)).status).toBe('completed');
    // 3 đơn vị đã xong lúc đầu là "[cue1+cue2]", cue 4, cue 5; chỉ cue 4 và cue 5 trùng văn bản → 11 − 2 lần gọi
    expect(postCount(mock)).toBe(9);
    expect((await voiceOfJob(job.id))!.timeline).toHaveLength(11);
  });

  it('chuyển sang "Đọc liên tục" khôi phục số đoạn của tệp và bỏ timing', async () => {
    const { job, file } = await failedAfterThree();
    const res = await patch(job.id, { timing: { mode: 'continuous' } });
    expect(res.status).toBe(200);
    const after = await jobRow(job.id);
    expect(after.settings.timing).toBeUndefined();
    expect(after.progressTotal).toBe(file.segmentCount);
    expect((await segmentRows(job.id)).length).toBe(file.segmentCount);
    expect((await res.json()).settings.timing).toBeNull();
  });

  it('chỉ đổi giọng/tốc độ: giữ timing và danh sách đơn vị, mọi đoạn về pending (hành vi spec 001)', async () => {
    const { job } = await failedAfterThree();
    const res = await patch(job.id, { speed: 1.2 });
    expect(res.status).toBe(200);
    const after = await jobRow(job.id);
    expect(after.progressTotal).toBe(10);
    expect(after.settings.timing).toMatchObject({ mode: 'timed', mergeCues: true });
    expect((await segmentRows(job.id)).every((s) => s.status === 'pending')).toBe(true);
  });

  it('gửi lại đúng timing hiện tại thì không dựng lại hàng trạng thái', async () => {
    const { job } = await failedAfterThree();
    const before = await segmentRows(job.id);
    expect((await patch(job.id, { timing: { mode: 'timed', mergeCues: true } })).status).toBe(200);
    const after = await segmentRows(job.id);
    expect(after.map((s) => s.status)).toEqual(before.map((s) => s.status));
    expect((await jobRow(job.id)).progressTotal).toBe(10);
  });

  it('tệp không có mốc → 409 NO_TIMECODES khi đổi sang khớp mốc', async () => {
    await setScenario(admin, mock, 'ok-then-5xx-1');
    const projectId = await newProject(user);
    const file = await uploadScript(user, projectId, 'Câu một.\nCâu hai.\nCâu ba.', 'a.txt');
    const job = await startJob(user, projectId, file.id);
    await runGenerateVoice(job.id, FAST);
    expect((await jobRow(job.id)).status).toBe('failed');
    const res = await patch(job.id, { timing: { mode: 'timed' } });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('NO_TIMECODES');
  });

  it('người dùng khác không sửa được → 404; timing sai kiểu → 422', async () => {
    const { job } = await failedAfterThree();
    const other = await createUser({ name: 'Người khác' });
    expect((await patch(job.id, { timing: { mode: 'continuous' } }, other)).status).toBe(404);
    expect((await patch(job.id, { timing: { mode: 'nhanh' } })).status).toBe(422);
  });

  it('chạy lại từ job khớp mốc giữ chế độ khớp mốc và "Ghép cue cùng câu"', async () => {
    const { job } = await failedAfterThree();
    await setScenario(admin, mock, 'ok');
    const res = await user.client.post(`/api/jobs/${job.id}/rerun`, { json: {} });
    expect(res.status).toBeLessThan(300);
    const created = await res.json();
    const row = await jobRow(created.id);
    expect(row.settings.timing).toMatchObject({ mode: 'timed', mergeCues: true });
    expect(row.progressTotal).toBe(10);
  });
});
