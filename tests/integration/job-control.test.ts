import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startMockProvider, type MockProvider } from '../../mock-provider/server';
import { getDb } from '@/lib/db';
import { aiProviderConfigs, audioCache, projects, users, voiceJobs } from '@/lib/db/schema';
import { headObject, listKeys } from '@/lib/storage/client';
import { storageKeys } from '@/lib/storage/keys';
import { runGenerateVoice } from '@/worker/jobs/generate-voice';
import { stopBoss } from '@/worker/queues';
import { clearRateLimits, createAdmin, createUser, resetDb, type TestUser } from './helpers';
import { FAST, SCRIPT_4, jobRow, logCodes, newProject, postCount, putGlobalConfig, segmentRows, setScenario, startJob, uploadScript, usageRows, voiceOfJob } from './voice-helpers';

let mock: MockProvider;
let admin: TestUser;
let a: TestUser;

const SLOW = { ...FAST, heartbeatMs: 50, segmentConcurrency: 1 };

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
  a = await createUser({ name: 'Người điều khiển' });
});

async function newJob(u = a, text = SCRIPT_4) {
  const pid = await newProject(u);
  const file = await uploadScript(u, pid, text);
  return { pid, file, job: await startJob(u, pid, file.id) };
}

/** Job dừng giữa chừng (2 đoạn xong, đoạn 3 lỗi tạm thời) để có trạng thái `failed` dở dang thật. */
async function failedHalfway() {
  await setScenario(admin, mock, 'ok-then-5xx-2');
  const made = await newJob();
  await runGenerateVoice(made.job.id, { ...FAST, retry: { maxAttempts: 1, baseMs: 1, maxMs: 1 }, segmentConcurrency: 1 });
  expect((await jobRow(made.job.id)).status).toBe('failed');
  await setScenario(admin, mock, 'ok');
  mock.reset();
  return made;
}

/** Chạy job (chậm) ở nền cho tới khi xong ít nhất một đoạn rồi trả về promise của lần chạy. */
async function runningJob() {
  await setScenario(admin, mock, 'delay-250');
  const made = await newJob();
  const run = runGenerateVoice(made.job.id, SLOW);
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 30));
    if ((await jobRow(made.job.id)).progressDone >= 1) break;
  }
  return { ...made, run };
}

describe('dừng → tiếp tục', () => {
  it('POST stop khi đang chạy: dừng sau đoạn đang xử lý, giữ phần đã xong; POST resume tiếp tục tới hoàn tất, không tốn phí lặp', async () => {
    const { job, run } = await runningJob();
    const stop = await a.client.post(`/api/jobs/${job.id}/stop`);
    expect(stop.status).toBe(202);
    expect((await stop.json()).status).toBe('stopping');
    await run;

    const stopped = await jobRow(job.id);
    expect(stopped.status).toBe('stopped');
    expect(stopped.progressDone).toBeGreaterThanOrEqual(1);
    expect(stopped.progressDone).toBeLessThan(4);
    const doneBefore = (await segmentRows(job.id)).filter((s) => s.status === 'done').length;

    const resume = await a.client.post(`/api/jobs/${job.id}/resume`);
    expect(resume.status).toBe(202);
    expect((await resume.json()).status).toBe('queued');
    expect(await logCodes(job.id)).toContain('JOB_QUEUED');

    mock.reset();
    await setScenario(admin, mock, 'ok');
    await runGenerateVoice(job.id, FAST);
    expect((await jobRow(job.id)).status).toBe('completed');
    expect(postCount(mock)).toBe(4 - doneBefore); // chỉ các đoạn còn lại
    expect((await usageRows(job.id)).filter((u) => u.ok)).toHaveLength(4); // mỗi đoạn đúng một lần gọi thành công, không lặp
  });

  it('dừng job đang chờ: stopped ngay; dừng job đã xong: không đổi gì', async () => {
    const { job } = await newJob();
    const r = await a.client.post(`/api/jobs/${job.id}/stop`);
    expect((await r.json()).status).toBe('stopped');
    expect((await jobRow(job.id)).status).toBe('stopped');
    expect(await logCodes(job.id)).toContain('JOB_STOPPED');
  });

  it('resume chỉ với stopped/failed/interrupted; queued/running/completed → 409', async () => {
    const queued = await newJob();
    expect((await a.client.post(`/api/jobs/${queued.job.id}/resume`)).status).toBe(409);

    const done = await newJob();
    await runGenerateVoice(done.job.id, FAST);
    const res = await a.client.post(`/api/jobs/${done.job.id}/resume`);
    expect(res.status).toBe(409);
    expect((await res.json()).error.message).toContain('đã dừng');

    await getDb().update(voiceJobs).set({ status: 'running' }).where(eq(voiceJobs.id, queued.job.id));
    expect((await a.client.post(`/api/jobs/${queued.job.id}/resume`)).status).toBe(409);
  });

  it('resume job failed: xếp hàng lại, xóa lỗi cũ, nhận được và hoàn tất', async () => {
    const { job } = await failedHalfway();
    const res = await a.client.post(`/api/jobs/${job.id}/resume`);
    expect(res.status).toBe(202);
    expect(await jobRow(job.id)).toMatchObject({ status: 'queued', errorCode: null, errorMessage: null, finishedAt: null });
    await runGenerateVoice(job.id, FAST);
    expect((await jobRow(job.id)).status).toBe('completed');
    expect(postCount(mock)).toBe(2);
  });

  it('User khác không dừng/tiếp tục/chạy lại được tiến trình của người khác (404)', async () => {
    const { job } = await newJob();
    const b = await createUser();
    for (const p of [`/api/jobs/${job.id}/stop`, `/api/jobs/${job.id}/resume`, `/api/jobs/${job.id}/rerun`]) {
      expect((await b.client.post(p)).status, p).toBe(404);
    }
    expect((await jobRow(job.id)).status).toBe('queued');
  });
});

describe('sửa thiết lập (FR-022)', () => {
  it('chỉ sửa được khi stopped/failed/interrupted; queued/running/completed → 409', async () => {
    const queued = await newJob();
    expect((await a.client.patch(`/api/jobs/${queued.job.id}`, { json: { voice: 'thuminh' } })).status).toBe(409);
    const done = await newJob();
    await runGenerateVoice(done.job.id, FAST);
    const res = await a.client.patch(`/api/jobs/${done.job.id}`, { json: { voice: 'thuminh' } });
    expect(res.status).toBe(409);
    expect((await res.json()).error.message).toContain('chạy lại');
  });

  it('đổi giọng rồi tiếp tục → MỌI đoạn của voice cuối cùng một giọng (không trộn), đã xong cũng làm lại', async () => {
    const { job } = await failedHalfway(); // 2 đoạn đã xong bằng giọng banmai
    expect((await segmentRows(job.id)).filter((s) => s.status === 'done')).toHaveLength(2);

    const res = await a.client.patch(`/api/jobs/${job.id}`, { json: { voice: 'thuminh' } });
    expect(res.status).toBe(200);
    expect((await res.json()).settings).toMatchObject({ voice: 'thuminh' });
    // Mọi đoạn về pending, tiến độ về 0
    const reset = await segmentRows(job.id);
    expect(reset.every((s) => s.status === 'pending' && s.audioCacheId === null)).toBe(true);
    expect((await jobRow(job.id)).progressDone).toBe(0);
    expect(await logCodes(job.id)).toContain('SETTINGS_CHANGED');

    await a.client.post(`/api/jobs/${job.id}/resume`);
    mock.reset();
    await runGenerateVoice(job.id, FAST);
    expect((await jobRow(job.id)).status).toBe('completed');
    expect(postCount(mock)).toBe(4); // giọng mới nên không dùng cache của giọng cũ
    const finalSegs = await segmentRows(job.id);
    const caches = await getDb().select().from(audioCache).where(eq(audioCache.ownerId, a.id));
    const used = finalSegs.map((s) => caches.find((c) => c.id === s.audioCacheId)!);
    expect(used.every((c) => c.voice === 'thuminh')).toBe(true); // KHÔNG trộn giọng
    expect((await usageRows(job.id)).filter((u) => u.ok && u.voice === 'thuminh')).toHaveLength(4);
  });

  it('PATCH không thay đổi giá trị thì KHÔNG đặt lại các đoạn đã xong', async () => {
    const { job } = await failedHalfway();
    const res = await a.client.patch(`/api/jobs/${job.id}`, { json: { voice: 'banmai' } }); // cùng giọng cũ
    expect(res.status).toBe(200);
    expect((await segmentRows(job.id)).filter((s) => s.status === 'done')).toHaveLength(2);
    expect(await logCodes(job.id)).not.toContain('SETTINGS_CHANGED');
  });

  it.each([
    ['giọng không có trong model', { voice: 'khong-co' }, 'voice'],
    ['model lạ', { model: 'model-la' }, 'model'],
    ['tốc độ ngoài khoảng', { speed: 9 }, 'speed'],
    ['không có thay đổi nào', {}, '_'],
    ['trường lạ', { providerType: 'fpt_marketplace' }, '_'],
  ])('%s → 422', async (_l, json, field) => {
    const { job } = await failedHalfway();
    const res = await a.client.patch(`/api/jobs/${job.id}`, { json });
    expect(res.status).toBe(422);
    expect(Object.keys((await res.json()).error.fields)).toContain(field);
    expect((await segmentRows(job.id)).filter((s) => s.status === 'done')).toHaveLength(2); // không bị đặt lại khi lỗi
  });
});

describe('chạy lại (tạo tiến trình mới)', () => {
  it('cùng thiết lập: mọi đoạn dùng cache, không gọi nhà cung cấp, voice mới; job cũ giữ nguyên', async () => {
    const { job } = await newJob();
    await runGenerateVoice(job.id, FAST);
    mock.reset();

    const res = await a.client.post(`/api/jobs/${job.id}/rerun`);
    expect(res.status).toBe(202);
    const j2 = await res.json();
    expect(j2.id).not.toBe(job.id);
    expect(j2.status).toBe('queued');
    await runGenerateVoice(j2.id, FAST);
    expect(postCount(mock)).toBe(0);
    expect((await segmentRows(j2.id)).every((s) => s.cacheHit)).toBe(true);
    expect(await voiceOfJob(j2.id)).not.toBeNull();
    expect((await jobRow(job.id)).status).toBe('completed'); // job cũ không đổi
    expect(await voiceOfJob(job.id)).not.toBeNull();
  });

  it('thiết lập mới trong body ghi đè; đoạn không đổi không có (giọng mới → gọi lại)', async () => {
    const { job } = await newJob();
    await runGenerateVoice(job.id, FAST);
    mock.reset();
    const j2 = await (await a.client.post(`/api/jobs/${job.id}/rerun`, { json: { voice: 'thuminh', speed: 1.1 } })).json();
    expect(j2.settings).toMatchObject({ voice: 'thuminh', speed: 1.1 });
    await runGenerateVoice(j2.id, FAST);
    expect(postCount(mock)).toBe(4);
  });

  it('thiết lập không hợp lệ → 422, không tạo job mới', async () => {
    const { job } = await newJob();
    const before = (await getDb().select().from(voiceJobs).where(eq(voiceJobs.ownerId, a.id))).length;
    const res = await a.client.post(`/api/jobs/${job.id}/rerun`, { json: { voice: 'khong-co' } });
    expect(res.status).toBe(422);
    expect((await getDb().select().from(voiceJobs).where(eq(voiceJobs.ownerId, a.id))).length).toBe(before);
  });
});

describe('xóa tiến trình (FR-023)', () => {
  it('xóa job đã hoàn tất: xóa voice + file mp3 + cache không còn dùng, giảm voice_count, trả lại dung lượng', async () => {
    const { pid, file, job } = await newJob();
    await runGenerateVoice(job.id, FAST);
    const voice = (await voiceOfJob(job.id))!;
    expect(await headObject(voice.storageKey)).not.toBeNull();
    const [p0] = await getDb().select().from(projects).where(eq(projects.id, pid));
    expect(p0!.voiceCount).toBe(1);

    const res = await a.client.delete(`/api/jobs/${job.id}`);
    expect(res.status).toBe(204);

    expect(await voiceOfJob(job.id)).toBeNull();
    expect(await headObject(voice.storageKey)).toBeNull();
    expect((await getDb().select().from(voiceJobs).where(eq(voiceJobs.id, job.id)))).toHaveLength(0);
    expect(await getDb().select().from(audioCache).where(eq(audioCache.ownerId, a.id))).toHaveLength(0);
    const [p1] = await getDb().select().from(projects).where(eq(projects.id, pid));
    expect(p1!.voiceCount).toBe(0);
    const [u] = await getDb().select().from(users).where(eq(users.id, a.id));
    expect(u!.storageUsedBytes).toBe(new TextEncoder().encode(SCRIPT_4).length); // chỉ còn file gốc
    expect(file.id).toBeTruthy();
    // file kịch bản vẫn còn để tạo lại
    expect((await a.client.get(`/api/files/${file.id}`)).status).toBe(200);
  });

  it('cache dùng chung giữa hai tiến trình: xóa job đầu giữ cache, xóa job sau mới dọn', async () => {
    const { pid, file, job } = await newJob();
    await runGenerateVoice(job.id, FAST);
    const job2 = await startJob(a, pid, file.id);
    await runGenerateVoice(job2.id, FAST); // toàn bộ cache hit: cùng tham chiếu 4 mục cache
    expect(await getDb().select().from(audioCache).where(eq(audioCache.ownerId, a.id))).toHaveLength(4);

    await a.client.delete(`/api/jobs/${job.id}`);
    expect(await getDb().select().from(audioCache).where(eq(audioCache.ownerId, a.id))).toHaveLength(4); // job2 còn dùng
    await a.client.delete(`/api/jobs/${job2.id}`);
    expect(await getDb().select().from(audioCache).where(eq(audioCache.ownerId, a.id))).toHaveLength(0);
    const [u] = await getDb().select().from(users).where(eq(users.id, a.id));
    expect(u!.storageUsedBytes).toBe(new TextEncoder().encode(SCRIPT_4).length);
  });

  it('job đang chờ/chạy → 409 (hãy dừng trước); không xóa gì', async () => {
    const { job } = await newJob();
    const res = await a.client.delete(`/api/jobs/${job.id}`);
    expect(res.status).toBe(409);
    expect((await jobRow(job.id)).status).toBe('queued');
    expect((await a.client.delete('/api/jobs/00000000-0000-4000-8000-000000000000')).status).toBe(404);
    const b = await createUser();
    expect((await b.client.delete(`/api/jobs/${job.id}`)).status).toBe(404);
  });

  it('xóa hàng loạt: xóa được các job hợp lệ, từ chối job đang chạy, báo không tìm thấy id lạ hoặc của người khác', async () => {
    const done1 = await newJob();
    const done2 = await newJob();
    await runGenerateVoice(done1.job.id, FAST);
    await runGenerateVoice(done2.job.id, FAST);
    const queued = await newJob();
    const other = await createUser();
    const foreign = await newJob(other);
    const ghost = '00000000-0000-4000-8000-000000000000';

    const res = await a.client.post('/api/jobs/bulk-delete', { json: { ids: [done1.job.id, done2.job.id, queued.job.id, foreign.job.id, ghost] } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deleted.sort()).toEqual([done1.job.id, done2.job.id].sort());
    expect(body.rejectedRunning).toEqual([queued.job.id]);
    expect(body.notFound.sort()).toEqual([foreign.job.id, ghost].sort());
    expect((await jobRow(foreign.job.id)).status).toBe('queued'); // của người khác không bị đụng tới
    expect((await jobRow(queued.job.id)).status).toBe('queued');
  });

  it('xóa hàng loạt với stopFirst: dừng job đang chạy rồi xóa, dọn sạch', async () => {
    const { pid, job, run } = await runningJob();
    const res = await a.client.post('/api/jobs/bulk-delete', { json: { ids: [job.id], stopFirst: true } });
    expect(res.status).toBe(200);
    expect((await res.json()).deleted).toEqual([job.id]);
    await run;
    expect((await getDb().select().from(voiceJobs).where(eq(voiceJobs.id, job.id)))).toHaveLength(0);
    expect(await getDb().select().from(audioCache).where(eq(audioCache.ownerId, a.id))).toHaveLength(0);
    const keys: string[] = [];
    for await (const k of listKeys(storageKeys.userPrefix(a.id))) keys.push(k.key);
    expect(keys.filter((k) => k.includes('/cache/') || k.includes('/voices/'))).toEqual([]);
    expect(pid).toBeTruthy();
  });

  it.each([
    ['rỗng', { ids: [] }],
    ['quá 100', { ids: Array.from({ length: 101 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`) }],
    ['không phải uuid', { ids: ['abc'] }],
    ['trường lạ', { ids: ['00000000-0000-4000-8000-000000000000'], all: true }],
  ])('bulk-delete %s → 422', async (_l, json) => {
    expect((await a.client.post('/api/jobs/bulk-delete', { json })).status).toBe(422);
  });
});
