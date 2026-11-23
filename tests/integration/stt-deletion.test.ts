import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '@/lib/db';
import { sttJobLogs, sttJobs, sttProviderConfigs, usageRecords } from '@/lib/db/schema';
import { headObject, listKeys } from '@/lib/storage/client';
import { runTranscribeMedia } from '@/worker/jobs/transcribe-media';
import { deleteUserData } from '@/worker/jobs/delete-user';
import { stopBoss } from '@/worker/queues';
import { startSonioxMock, type SonioxMock } from '../mocks/soniox-mock';
import { clearRateLimits, createAdmin, createUser, resetDb, type TestUser } from './helpers';
import { newProject } from './voice-helpers';
import { createSttJobApi, FAST_STT, putSonioxConfig, SONIOX_KEY, sttJobRow, sttLogKeys, sttUsageRows } from './stt-helpers';
import { SonioxSttClient } from '@/lib/providers/adapters/soniox';
import { createSafeFetch } from '@/lib/security/safe-fetch';

/** Xóa Project/User xóa sạch dữ liệu STT, kể cả trên Soniox (spec 004, FR-021, Hiến pháp V, T050c). */
let mock: SonioxMock;
let admin: TestUser;
let user: TestUser;

beforeAll(async () => {
  mock = await startSonioxMock();
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
  await getDb().delete(sttProviderConfigs);
  user = await createUser();
});

/** Job đang dở: đã có file + transcription trên Soniox, file tạm còn trên MinIO. */
async function halfDoneJob(projectId: string) {
  const job = await createSttJobApi(user, projectId);
  const c = new SonioxSttClient({ config: { baseUrl: mock.baseUrl('ok'), apiKey: SONIOX_KEY }, fetch: createSafeFetch({ allowInsecure: true }) });
  const { fileId } = await c.uploadAudioFile(new Uint8Array([1, 2]), 'a.mp3');
  const { transcriptionId } = await c.startTranscription(fileId, { model: 'stt-async-v6' });
  await getDb().update(sttJobs).set({ sonioxFileId: fileId, sonioxTranscriptionId: transcriptionId }).where(eq(sttJobs.id, job.id));
  await getDb().insert(sttJobLogs).values({ sttJobId: job.id, level: 'info', messageKey: 'started' });
  return { jobId: job.id, fileId, transcriptionId, tempKey: (await sttJobRow(job.id))!.tempStorageKey! };
}

describe('xóa dữ liệu STT', () => {
  it('xóa Project: mất STT job + nhật ký + file tạm, dữ liệu trên Soniox bị xóa', async () => {
    await putSonioxConfig(admin, mock);
    const projectId = await newProject(user);
    const j = await halfDoneJob(projectId);
    expect(await headObject(j.tempKey)).not.toBeNull();

    const res = await user.client.delete(`/api/projects/${projectId}`);
    expect(res.status).toBeLessThan(300);
    expect(await sttJobRow(j.jobId)).toBeUndefined();
    expect(await getDb().select().from(sttJobLogs).where(eq(sttJobLogs.sttJobId, j.jobId))).toHaveLength(0);
    expect(await headObject(j.tempKey)).toBeNull();
    expect(mock.deleted.files.has(j.fileId)).toBe(true);
    expect(mock.deleted.transcriptions.has(j.transcriptionId)).toBe(true);
  });

  it('xóa User: không còn đối tượng nào dưới users/{id}/; usage giữ lại ở dạng ẩn danh', async () => {
    await putSonioxConfig(admin, mock);
    const projectId = await newProject(user);
    const done = await createSttJobApi(user, projectId);
    await runTranscribeMedia(done.id, FAST_STT);
    expect((await sttUsageRows(done.id)).filter((u) => u.ok)).toHaveLength(1);
    const half = await halfDoneJob(projectId);

    await deleteUserData(user.id);
    const left: string[] = [];
    for await (const o of listKeys(`users/${user.id}/`)) left.push(o.key);
    expect(left).toEqual([]);
    expect(mock.deleted.files.has(half.fileId)).toBe(true);
    // usage: stt_job_id và user_id thành NULL nhưng bản ghi còn để thống kê tổng hợp
    const [{ n } = { n: 0 }] = (await getDb().execute(sql`select count(*)::int as n from usage_records where provider_type = 'soniox' and user_id is null and stt_job_id is null and ok`)).rows as Array<{ n: number }>;
    expect(n).toBeGreaterThanOrEqual(1);
    expect(await getDb().select().from(usageRecords).where(eq(usageRecords.userId, user.id))).toHaveLength(0);
  });

  it('worker đang chạy job vừa bị xóa: dừng và không để lại file tạm', async () => {
    await putSonioxConfig(admin, mock, 'ok+slow-50');
    const projectId = await newProject(user);
    const job = await createSttJobApi(user, projectId);
    const running = runTranscribeMedia(job.id, { ...FAST_STT, pollMs: 20, maxPollMs: 20 });
    // chờ tới lúc đang phiên âm rồi xóa Project
    for (let i = 0; i < 200 && (await sttJobRow(job.id))?.status !== 'transcribing'; i++) await new Promise((r) => setTimeout(r, 20));
    expect(await sttLogKeys(job.id)).toContain('uploaded');
    await user.client.delete(`/api/projects/${projectId}`);
    await running;
    expect(await sttJobRow(job.id)).toBeUndefined();
    const left: string[] = [];
    for await (const o of listKeys(`users/${user.id}/stt-tmp/`)) left.push(o.key);
    expect(left).toEqual([]);
    expect(mock.deleted.files.size).toBe(1);
  });
});
