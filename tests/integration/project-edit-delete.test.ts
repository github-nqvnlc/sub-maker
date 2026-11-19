import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startMockProvider, type MockProvider } from '../../mock-provider/server';
import { getDb } from '@/lib/db';
import {
  aiProviderConfigs,
  audioCache,
  jobLogs,
  jobSegments,
  projects,
  segments,
  subtitleFiles,
  users,
  voiceJobs,
  voices,
} from '@/lib/db/schema';
import { headObject, listKeys } from '@/lib/storage/client';
import { storageKeys } from '@/lib/storage/keys';
import { runGenerateVoice } from '@/worker/jobs/generate-voice';
import { stopBoss } from '@/worker/queues';
import { clearRateLimits, createAdmin, createUser, resetDb, type TestUser } from './helpers';
import { FAST, SCRIPT_4, jobRow, newProject, putGlobalConfig, setScenario, startJob, uploadScript, voiceOfJob } from './voice-helpers';

let mock: MockProvider;
let admin: TestUser;
let a: TestUser;

const SCRIPT_BYTES = new TextEncoder().encode(SCRIPT_4).length;

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
  a = await createUser({ name: 'Người sở hữu' });
});

/** Project có một file kịch bản và một voice hoàn tất. */
async function projectWithVoice(u = a) {
  const pid = await newProject(u);
  const file = await uploadScript(u, pid, SCRIPT_4);
  const job = await startJob(u, pid, file.id);
  await runGenerateVoice(job.id, FAST);
  const voice = (await voiceOfJob(job.id))!;
  return { pid, file, job, voice };
}

async function userKeys(userId: string): Promise<string[]> {
  const keys: string[] = [];
  for await (const k of listKeys(storageKeys.userPrefix(userId))) keys.push(k.key);
  return keys;
}

describe('sửa Project (FR-003)', () => {
  it('sửa tên, mô tả, nhà cung cấp; updatedAt đổi; các trường không gửi giữ nguyên', async () => {
    const pid = await newProject(a, 'Tên cũ');
    const before = (await getDb().select().from(projects).where(eq(projects.id, pid)))[0]!;
    await new Promise((r) => setTimeout(r, 20));
    const res = await a.client.patch(`/api/projects/${pid}`, { json: { name: '  Tên mới  ', description: 'Mô tả mới', providerType: 'fpt_marketplace' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: pid, name: 'Tên mới', description: 'Mô tả mới', providerType: 'fpt_marketplace' });
    const after = (await getDb().select().from(projects).where(eq(projects.id, pid)))[0]!;
    expect(after.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
    expect(after.createdAt.getTime()).toBe(before.createdAt.getTime());

    const partial = await a.client.patch(`/api/projects/${pid}`, { json: { description: null } });
    expect(await partial.json()).toMatchObject({ name: 'Tên mới', description: null, providerType: 'fpt_marketplace' });
  });

  it.each([
    ['tên rỗng', { name: '' }, 'name'],
    ['tên chỉ khoảng trắng', { name: '   ' }, 'name'],
    ['tên 121 ký tự', { name: 'x'.repeat(121) }, 'name'],
    ['mô tả 2001 ký tự', { description: 'y'.repeat(2001) }, 'description'],
    ['nhà cung cấp lạ', { providerType: 'khong-co' }, 'providerType'],
    ['không có thay đổi', {}, '_'],
    ['trường lạ (ownerId)', { ownerId: 'x' }, '_'],
  ])('%s → 422 và không đổi dữ liệu', async (_l, json, field) => {
    const pid = await newProject(a, 'Giữ nguyên');
    const res = await a.client.patch(`/api/projects/${pid}`, { json });
    expect(res.status).toBe(422);
    expect(Object.keys((await res.json()).error.fields)).toContain(field);
    expect((await getDb().select().from(projects).where(eq(projects.id, pid)))[0]!.name).toBe('Giữ nguyên');
  });

  it('User khác không sửa được (404) và không thể chuyển Project sang chủ khác', async () => {
    const pid = await newProject(a);
    const b = await createUser();
    expect((await b.client.patch(`/api/projects/${pid}`, { json: { name: 'Chiếm đoạt' } })).status).toBe(404);
    expect((await getDb().select().from(projects).where(eq(projects.id, pid)))[0]).toMatchObject({ name: 'Dự án thử', ownerId: a.id });
  });
});

describe('xóa một Project (FR-004)', () => {
  it('xóa sạch mọi dữ liệu liên quan: bản ghi, file, voice, cache, đối tượng MinIO; trả lại dung lượng', async () => {
    const { pid, file, voice } = await projectWithVoice();
    expect((await userKeys(a.id)).length).toBeGreaterThanOrEqual(6); // 1 file gốc + 4 cache + 1 mp3
    const fileRow = (await getDb().select().from(subtitleFiles).where(eq(subtitleFiles.id, file.id)))[0]!;

    const res = await a.client.delete(`/api/projects/${pid}`);
    expect(res.status).toBe(204);

    expect(await getDb().select().from(projects).where(eq(projects.id, pid))).toHaveLength(0);
    expect(await getDb().select().from(subtitleFiles).where(eq(subtitleFiles.projectId, pid))).toHaveLength(0);
    expect(await getDb().select().from(segments).where(eq(segments.subtitleFileId, file.id))).toHaveLength(0);
    expect(await getDb().select().from(voiceJobs).where(eq(voiceJobs.projectId, pid))).toHaveLength(0);
    expect(await getDb().select().from(voices).where(eq(voices.projectId, pid))).toHaveLength(0);
    expect(await getDb().select().from(audioCache).where(eq(audioCache.ownerId, a.id))).toHaveLength(0);
    expect(await headObject(voice.storageKey)).toBeNull();
    expect(await headObject(fileRow.storageKey)).toBeNull();
    expect(await userKeys(a.id)).toEqual([]); // không còn đối tượng mồ côi nào
    expect((await getDb().select().from(users).where(eq(users.id, a.id)))[0]!.storageUsedBytes).toBe(0);
    expect((await a.client.get(`/api/projects/${pid}`)).status).toBe(404);
  });

  it('không còn bản ghi mồ côi trong job_segments/job_logs sau khi xóa', async () => {
    const { pid, job } = await projectWithVoice();
    await a.client.delete(`/api/projects/${pid}`);
    expect(await getDb().select().from(jobSegments).where(eq(jobSegments.jobId, job.id))).toHaveLength(0);
    expect(await getDb().select().from(jobLogs).where(eq(jobLogs.jobId, job.id))).toHaveLength(0);
  });

  it('Project khác của cùng User không bị ảnh hưởng (kể cả dùng chung cache)', async () => {
    const one = await projectWithVoice();
    const pid2 = await newProject(a, 'Project thứ hai');
    const file2 = await uploadScript(a, pid2, SCRIPT_4); // cùng nội dung → dùng chung 4 mục cache
    const job2 = await startJob(a, pid2, file2.id);
    await runGenerateVoice(job2.id, FAST);
    expect(await getDb().select().from(audioCache).where(eq(audioCache.ownerId, a.id))).toHaveLength(4);

    await a.client.delete(`/api/projects/${one.pid}`);
    // cache còn vì Project thứ hai vẫn dùng; voice của Project hai nghe được
    expect(await getDb().select().from(audioCache).where(eq(audioCache.ownerId, a.id))).toHaveLength(4);
    const v2 = (await voiceOfJob(job2.id))!;
    expect(await headObject(v2.storageKey)).not.toBeNull();
    expect((await a.client.get(`/api/voices/${v2.id}/audio`)).status).toBe(200);
    expect((await a.client.get(`/api/projects/${pid2}`)).status).toBe(200);

    await a.client.delete(`/api/projects/${pid2}`);
    expect(await userKeys(a.id)).toEqual([]);
  });

  it('Project đang có tiến trình chạy: được dừng trước rồi xóa sạch, không để lại đối tượng mồ côi', async () => {
    await setScenario(admin, mock, 'delay-250');
    const pid = await newProject(a);
    const file = await uploadScript(a, pid, SCRIPT_4);
    const job = await startJob(a, pid, file.id);
    const run = runGenerateVoice(job.id, { ...FAST, heartbeatMs: 50, segmentConcurrency: 1 });
    for (let i = 0; i < 100; i++) {
      await new Promise((r) => setTimeout(r, 30));
      if ((await jobRow(job.id)).progressDone >= 1) break;
    }
    const res = await a.client.delete(`/api/projects/${pid}`);
    expect(res.status).toBe(204);
    await run;
    expect(await getDb().select().from(voiceJobs).where(eq(voiceJobs.id, job.id))).toHaveLength(0);
    expect(await getDb().select().from(audioCache).where(eq(audioCache.ownerId, a.id))).toHaveLength(0);
    expect(await userKeys(a.id)).toEqual([]);
    expect((await getDb().select().from(users).where(eq(users.id, a.id)))[0]!.storageUsedBytes).toBe(0);
  });

  it('User khác không xóa được (404), dữ liệu còn nguyên; id sai/không tồn tại → 404', async () => {
    const { pid } = await projectWithVoice();
    const b = await createUser();
    expect((await b.client.delete(`/api/projects/${pid}`)).status).toBe(404);
    expect((await a.client.delete('/api/projects/khong-phai-uuid')).status).toBe(404);
    expect((await a.client.delete('/api/projects/00000000-0000-4000-8000-000000000000')).status).toBe(404);
    expect((await a.client.get(`/api/projects/${pid}`)).status).toBe(200);
  });
});

describe('xóa nhiều Project (FR-004, SC-009)', () => {
  it('xóa hàng loạt: báo từng mục, không đụng Project của người khác hay id lạ', async () => {
    const p1 = await newProject(a, 'A1');
    const p2 = await newProject(a, 'A2');
    const keep = await newProject(a, 'Giữ lại');
    const b = await createUser();
    const foreign = await newProject(b, 'Của B');
    const ghost = '00000000-0000-4000-8000-000000000000';

    const res = await a.client.post('/api/projects/bulk-delete', { json: { ids: [p1, p2, foreign, ghost, p1] } }); // p1 lặp
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deleted.sort()).toEqual([p1, p2].sort());
    expect(body.notFound.sort()).toEqual([foreign, ghost].sort());
    expect((await a.client.get(`/api/projects/${keep}`)).status).toBe(200);
    expect((await b.client.get(`/api/projects/${foreign}`)).status).toBe(200);
  });

  it('xóa 10 Project (mỗi cái có voice) trong dưới 5 giây và dọn sạch hoàn toàn', async () => {
    const pids: string[] = [];
    for (let i = 0; i < 10; i++) {
      // dùng chung nội dung giữa các Project để cache dùng chung, nhưng mỗi Project có file + job + voice riêng
      const pid = await newProject(a, `Project ${i}`);
      const file = await uploadScript(a, pid, `Kịch bản số ${i} đủ dài để đọc.\nDòng hai của kịch bản ${i}.`);
      const job = await startJob(a, pid, file.id);
      await runGenerateVoice(job.id, FAST);
      pids.push(pid);
    }
    expect((await userKeys(a.id)).length).toBeGreaterThan(30);

    const t0 = performance.now();
    const res = await a.client.post('/api/projects/bulk-delete', { json: { ids: pids } });
    const ms = performance.now() - t0;
    expect(res.status).toBe(200);
    expect((await res.json()).deleted).toHaveLength(10);
    expect(ms).toBeLessThan(5000);

    expect(await getDb().select().from(projects).where(eq(projects.ownerId, a.id))).toHaveLength(0);
    expect(await getDb().select().from(audioCache).where(eq(audioCache.ownerId, a.id))).toHaveLength(0);
    expect(await userKeys(a.id)).toEqual([]);
    expect((await getDb().select().from(users).where(eq(users.id, a.id)))[0]!.storageUsedBytes).toBe(0);
  }, 120_000);

  it.each([
    ['rỗng', { ids: [] }],
    ['không phải uuid', { ids: ['abc'] }],
    ['quá 100 mục', { ids: Array.from({ length: 101 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`) }],
    ['trường lạ', { ids: ['00000000-0000-4000-8000-000000000000'], force: true }],
  ])('bulk-delete %s → 422', async (_l, json) => {
    expect((await a.client.post('/api/projects/bulk-delete', { json })).status).toBe(422);
  });

  it('chưa đăng nhập → 401; thiếu Origin → 403', async () => {
    const pid = await newProject(a);
    const { TestClient } = await import('./helpers');
    expect((await new TestClient().post('/api/projects/bulk-delete', { json: { ids: [pid] } })).status).toBe(401);
    expect((await a.client.post('/api/projects/bulk-delete', { json: { ids: [pid] }, origin: false })).status).toBe(403);
    expect((await a.client.get(`/api/projects/${pid}`)).status).toBe(200);
    expect(SCRIPT_BYTES).toBeGreaterThan(0);
  });
});
