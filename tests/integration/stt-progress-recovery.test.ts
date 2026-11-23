import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '@/lib/db';
import { sttProviderConfigs } from '@/lib/db/schema';
import { runTranscribeMedia } from '@/worker/jobs/transcribe-media';
import { stopBoss } from '@/worker/queues';
import { startSonioxMock, type SonioxMock } from '../mocks/soniox-mock';
import { clearRateLimits, createAdmin, createUser, resetDb, type TestUser } from './helpers';
import { newProject } from './voice-helpers';
import { createSttJobApi, FAST_STT, putSonioxConfig, SONIOX_KEY } from './stt-helpers';

/** Tiến độ và nhật ký quan sát được qua API (spec 004, US3, FR-020, T047). */
let mock: SonioxMock;
let admin: TestUser;
let user: TestUser;

type Detail = { status: string; progressPercent: number; errorCode: string | null; errorMessage: string | null; logs: Array<{ level: string; messageKey: string; params: unknown }> };

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

describe('GET /api/stt/{jobId}', () => {
  it('trước khi chạy: queued 0%; sau khi chạy: completed 100% kèm nhật ký từng giai đoạn', async () => {
    await putSonioxConfig(admin, mock, 'ok+slow-3');
    const projectId = await newProject(user);
    const job = await createSttJobApi(user, projectId);
    const before = (await (await user.client.get(`/api/stt/${job.id}`)).json()) as Detail;
    expect(before).toMatchObject({ status: 'queued', progressPercent: 0 });

    await runTranscribeMedia(job.id, FAST_STT);
    const after = (await (await user.client.get(`/api/stt/${job.id}`)).json()) as Detail;
    expect(after).toMatchObject({ status: 'completed', progressPercent: 100 });
    const keys = after.logs.map((l) => l.messageKey);
    expect(keys[0]).toBe('started');
    expect(keys.at(-1)).toBe('completed');
    expect(keys).toContain('transcribing');
    // 3 lần poll "processing" làm tiến độ tăng dần trước khi xong (đã kiểm ở DB qua trạng thái cuối)
    expect(mock.requests.filter((r) => r.method === 'GET' && /^\/v1\/transcriptions\/[^/]+$/.test(r.path)).length).toBe(4);
  });

  it('lỗi: failed kèm thông báo tiếng Việt và dòng nhật ký lỗi; không lộ khóa API', async () => {
    await putSonioxConfig(admin, mock, 'fail');
    const projectId = await newProject(user);
    const job = await createSttJobApi(user, projectId);
    await runTranscribeMedia(job.id, FAST_STT);
    const d = (await (await user.client.get(`/api/stt/${job.id}`)).json()) as Detail;
    expect(d).toMatchObject({ status: 'failed', errorCode: 'SONIOX_FAILED' });
    expect(d.errorMessage).toMatch(/Soniox không phiên âm được/);
    expect(d.logs.some((l) => l.level === 'error' && l.messageKey === 'failed')).toBe(true);
    expect(JSON.stringify(d)).not.toContain(SONIOX_KEY);
  });
});
