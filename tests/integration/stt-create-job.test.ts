import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '@/lib/db';
import { sttProviderConfigs, users } from '@/lib/db/schema';
import { headObject } from '@/lib/storage/client';
import { stopBoss } from '@/worker/queues';
import { startSonioxMock, type SonioxMock } from '../mocks/soniox-mock';
import { clearRateLimits, createAdmin, createUser, resetDb, type TestUser } from './helpers';
import { newProject } from './voice-helpers';
import { createSttJobApi, fixture, postMedia, putSonioxConfig, sttJobRow } from './stt-helpers';

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
  await getDb().delete(sttProviderConfigs);
  await putSonioxConfig(admin, mock);
  user = await createUser({ name: 'Người tạo phụ đề' });
});

describe('POST /api/projects/{id}/stt (spec 004, US1)', () => {
  it('nhận file audio hợp lệ, lưu tạm MinIO dưới tiền tố User, tạo job queued', async () => {
    const projectId = await newProject(user);
    const job = await createSttJobApi(user, projectId, 'sample-10s.mp3', { language: 'vi', targetFormat: 'srt' });
    expect(job.status).toBe('queued');
    expect(job.targetFileName).toBe('sample-10s.srt');
    const row = (await sttJobRow(job.id))!;
    expect(row).toMatchObject({ ownerId: user.id, projectId, mediaType: 'audio', language: 'vi', targetFormat: 'srt', status: 'queued' });
    expect(row.tempStorageKey).toBe(`users/${user.id}/stt-tmp/${job.id}/source.mp3`);
    expect(await headObject(row.tempStorageKey!)).not.toBeNull();
  });

  it('mặc định tự nhận diện ngôn ngữ; tên kịch bản theo định dạng chọn', async () => {
    const projectId = await newProject(user);
    const job = await createSttJobApi(user, projectId, 'sample-video-5s.mp4', { targetFormat: 'md', targetFileName: 'Ghi chú họp' });
    const row = (await sttJobRow(job.id))!;
    expect(row.language).toBe('auto');
    expect(row.mediaType).toBe('video');
    expect(row.targetFileName).toBe('Ghi chú họp.md');
  });

  it('tạo job không làm tăng dung lượng đã dùng của User (FR-001)', async () => {
    const projectId = await newProject(user);
    const before = (await getDb().select({ u: users.storageUsedBytes }).from(users).where(eq(users.id, user.id)))[0]!.u;
    await createSttJobApi(user, projectId);
    const after = (await getDb().select({ u: users.storageUsedBytes }).from(users).where(eq(users.id, user.id)))[0]!.u;
    expect(after).toBe(before);
  });

  it('định dạng không hỗ trợ → 422 MEDIA_UNSUPPORTED', async () => {
    const projectId = await newProject(user);
    const res = await postMedia(user, projectId, { bytes: await fixture('sample-10s.srt'), name: 'x.srt' });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('MEDIA_UNSUPPORTED');
  });

  it('chưa cấu hình Soniox → 409 STT_NOT_CONFIGURED', async () => {
    await getDb().delete(sttProviderConfigs);
    const projectId = await newProject(user);
    const res = await postMedia(user, projectId, { bytes: await fixture('sample-10s.mp3'), name: 'a.mp3' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('STT_NOT_CONFIGURED');
  });

  it('GET danh sách job của Project', async () => {
    const projectId = await newProject(user);
    const job = await createSttJobApi(user, projectId);
    const res = await user.client.get(`/api/projects/${projectId}/stt`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as Array<{ id: string }>).map((j) => j.id)).toEqual([job.id]);
  });
});
