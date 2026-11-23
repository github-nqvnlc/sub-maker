import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '@/lib/db';
import { sttJobs, sttProviderConfigs } from '@/lib/db/schema';
import { headObject } from '@/lib/storage/client';
import { SonioxSttClient } from '@/lib/providers/adapters/soniox';
import { createSafeFetch } from '@/lib/security/safe-fetch';
import { runTranscribeMedia } from '@/worker/jobs/transcribe-media';
import { sweepStaleSttJobs } from '@/worker/sweeper';
import { stopBoss } from '@/worker/queues';
import { startSonioxMock, type SonioxMock } from '../mocks/soniox-mock';
import { clearRateLimits, createAdmin, createUser, resetDb, type TestUser } from './helpers';
import { newProject } from './voice-helpers';
import { createSttJobApi, FAST_STT, putSonioxConfig, SONIOX_KEY, sttJobRow, sttLogKeys, sttUsageRows } from './stt-helpers';

/** Thử lại lỗi tạm thời, không thử lại lỗi vĩnh viễn, tiếp tục sau gián đoạn (spec 004, FR-019, T047a). */
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

const posts = () => mock.requests.filter((r) => r.method === 'POST');

describe('thử lại', () => {
  it('429 rồi thành công: job vẫn completed, có dòng nhật ký thử lại, ghi usage cho lần lỗi', async () => {
    await putSonioxConfig(admin, mock, 'ok+429-2');
    const job = await createSttJobApi(user, await newProject(user));
    await runTranscribeMedia(job.id, FAST_STT);
    expect(await sttJobRow(job.id)).toMatchObject({ status: 'completed' });
    expect(await sttLogKeys(job.id)).toContain('retrying');
    const usage = await sttUsageRows(job.id);
    expect(usage.filter((u) => !u.ok)).toHaveLength(2);
    expect(usage.filter((u) => u.ok)).toHaveLength(1);
  });

  it('401: failed ngay, không thử lại', async () => {
    await putSonioxConfig(admin, mock, '401');
    const job = await createSttJobApi(user, await newProject(user));
    await runTranscribeMedia(job.id, FAST_STT);
    expect(await sttJobRow(job.id)).toMatchObject({ status: 'failed', errorCode: 'SONIOX_AUTH' });
    expect(mock.requests).toHaveLength(1);
  });

  it('5xx kéo dài: thử lại tối đa 3 lần rồi failed SONIOX_UNAVAILABLE', async () => {
    await putSonioxConfig(admin, mock, '5xx');
    const job = await createSttJobApi(user, await newProject(user));
    await runTranscribeMedia(job.id, FAST_STT);
    expect(await sttJobRow(job.id)).toMatchObject({ status: 'failed', errorCode: 'SONIOX_UNAVAILABLE' });
    expect(mock.requests).toHaveLength(4); // 1 lần đầu + 3 lần thử lại
  });
});

describe('gián đoạn và tiếp tục', () => {
  it('job chạy quá hạn → sweeper chuyển interrupted rồi xếp hàng lại', async () => {
    await putSonioxConfig(admin, mock);
    const job = await createSttJobApi(user, await newProject(user));
    await getDb().update(sttJobs).set({ status: 'transcribing', heartbeatAt: sql`now() - interval '10 minutes'` }).where(eq(sttJobs.id, job.id));
    const requeued: string[] = [];
    const r = await sweepStaleSttJobs({ requeue: async (id) => requeued.push(id) });
    expect(r.interrupted).toEqual([job.id]);
    expect(requeued).toEqual([job.id]);
    expect(await sttJobRow(job.id)).toMatchObject({ status: 'interrupted' });
    expect(await sttLogKeys(job.id)).toContain('interrupted');
  });

  it('đã có sonioxTranscriptionId: chỉ poll tiếp, không upload/tạo lại', async () => {
    await putSonioxConfig(admin, mock);
    const job = await createSttJobApi(user, await newProject(user));
    // Mô phỏng lần chạy trước đã upload + tạo transcription rồi worker chết
    const c = new SonioxSttClient({ config: { baseUrl: mock.baseUrl('ok'), apiKey: SONIOX_KEY }, fetch: createSafeFetch({ allowInsecure: true }) });
    const { fileId } = await c.uploadAudioFile(new Uint8Array([1, 2, 3]), 'a.mp3');
    const { transcriptionId } = await c.startTranscription(fileId, { model: 'stt-async-v6' });
    const tempKey = (await sttJobRow(job.id))!.tempStorageKey;
    await getDb()
      .update(sttJobs)
      .set({ status: 'interrupted', sonioxFileId: fileId, sonioxTranscriptionId: transcriptionId, model: 'stt-async-v6', attempt: 1 })
      .where(eq(sttJobs.id, job.id));
    mock.requests.length = 0;

    await runTranscribeMedia(job.id, FAST_STT);
    const row = (await sttJobRow(job.id))!;
    expect(row).toMatchObject({ status: 'completed', attempt: 2 });
    expect(posts()).toHaveLength(0); // không upload, không tạo transcription mới
    expect(await sttLogKeys(job.id)).toContain('resumed');
    // file tạm còn sót của lần trước cũng được dọn khi job kết thúc
    expect(row.tempStorageKey).toBeNull();
    expect(await headObject(tempKey!)).toBeNull();
    expect(mock.deleted.transcriptions.has(transcriptionId)).toBe(true);
  });
});
