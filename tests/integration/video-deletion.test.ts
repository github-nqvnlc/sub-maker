import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '@/lib/db';
import { systemSettings, users, videoCues, videoExports, videoJobLogs, videoJobs, videoUploads } from '@/lib/db/schema';
import { createMultipart, listKeys, listMultipartUploads, uploadPart } from '@/lib/storage/client';
import { storageKeys } from '@/lib/storage/keys';
import { deleteUserData, JobsStillRunningError } from '@/worker/jobs/delete-user';
import { stopBoss } from '@/worker/queues';
import { startSonioxMock, type SonioxMock } from '../mocks/soniox-mock';
import { clearRateLimits, createAdmin, createUser, resetDb, type TestUser } from './helpers';
import { putSonioxConfig } from './stt-helpers';
import { createVideoJobApi, putPart } from './video-api';
import { createExportApi, exportRow, fakeBurn, reviewJob, runExport, until } from './video-export-helpers';
import { grantVideo, videoJobRow, videoUsed } from './video-helpers';
import { newProject } from './voice-helpers';

/** Xóa việc, Project, User khi đang tải dở và đang xuất (spec 006, T075; FR-008, FR-057). */
let admin: TestUser;
let user: TestUser;
let projectId: string;
let mock: SonioxMock;

beforeAll(async () => {
  await resetDb();
  mock = await startSonioxMock();
  admin = await createAdmin();
}, 60_000);
afterAll(async () => {
  await mock.close();
  await stopBoss();
});
beforeEach(async () => {
  await clearRateLimits();
  await getDb().delete(videoExports);
  await getDb().delete(videoJobs);
  await getDb().update(users).set({ videoUsedBytes: 0 });
  await getDb().delete(systemSettings);
  mock.reset();
  await putSonioxConfig(admin, mock, 'ok', { enabled: true });
  user = await createUser();
  await grantVideo(admin, user.id);
  await getDb().insert(systemSettings).values({ key: 'videoMaxJobsPerUser', value: 5 });
  projectId = await newProject(user);
});

async function keysOf(ownerId: string): Promise<string[]> {
  const out: string[] = [];
  for await (const o of listKeys(storageKeys.userPrefix(ownerId))) if (o.key.includes('/video')) out.push(o.key);
  return out;
}
const storageUsed = async () => (await getDb().select({ n: users.storageUsedBytes }).from(users).where(eq(users.id, user.id)))[0]!.n;
const rows = async () => ({
  jobs: (await getDb().select().from(videoJobs).where(eq(videoJobs.ownerId, user.id))).length,
  uploads: (await getDb().select().from(videoUploads).where(eq(videoUploads.ownerId, user.id))).length,
  exports: (await getDb().select().from(videoExports).where(eq(videoExports.ownerId, user.id))).length,
});

/** Một video đã xuất xong, một video đang xuất (kèm phiên multipart dở của thành phẩm) và một video đang tải dở. */
async function busyData() {
  const done = await reviewJob(user, projectId);
  const first = await createExportApi(user, done.id);
  await runExport(first.id, { spawnRender: fakeBurn({ bytes: 9000 }).spawn });
  const second = await createExportApi(user, done.id);
  const hung = fakeBurn({ hold: true });
  const running = runExport(second.id, { spawnRender: hung.spawn });
  await until(() => hung.tasks.length === 1);
  const key = storageKeys.videoExport(user.id, done.id, second.id, 'mp4', 1);
  const multipart = await createMultipart(key, 'video/mp4');
  await uploadPart(key, multipart, 1, Buffer.alloc(5 * 1024 * 1024, 1));

  const bytes = Buffer.alloc(17 * 1024 * 1024, 7);
  const partial = await createVideoJobApi(user, projectId, bytes);
  await putPart(user, partial.upload.id, 1, bytes.subarray(0, partial.upload.partSize));
  const [upload] = await getDb().select().from(videoUploads).where(eq(videoUploads.id, partial.upload.id));
  return { done, running, exportKey: key, upload: upload! };
}

async function expectClean(data: Awaited<ReturnType<typeof busyData>>) {
  expect(await keysOf(user.id)).toEqual([]);
  expect(await listMultipartUploads(data.exportKey)).toEqual([]);
  expect(await listMultipartUploads(data.upload.key)).toEqual([]);
  expect(await rows()).toEqual({ jobs: 0, uploads: 0, exports: 0 });
  expect(await getDb().select().from(videoCues).where(eq(videoCues.jobId, data.done.id))).toEqual([]);
  expect(await getDb().select().from(videoJobLogs).where(eq(videoJobLogs.jobId, data.done.id))).toEqual([]);
}

describe('xóa khi đang tải dở và đang xuất', () => {
  it('xóa từng việc: tiến trình dừng, không còn đối tượng hay phiên multipart, hai bộ đếm đúng', async () => {
    const before = await storageUsed();
    const data = await busyData();
    expect(await videoUsed(user.id)).toBeGreaterThan(0);
    expect((await user.client.delete(`/api/video/jobs/${data.upload.jobId}`)).status).toBe(204);
    expect((await user.client.delete(`/api/video/jobs/${data.done.id}`)).status).toBe(204);
    await data.running;
    await expectClean(data);
    expect(await videoUsed(user.id)).toBe(0);
    expect(await storageUsed()).toBe(before);
  }, 90_000);

  it('xóa Project', async () => {
    const before = await storageUsed();
    const data = await busyData();
    // còn tiến trình chạy thì máy chủ yêu cầu dừng và chờ; tiến trình giả dừng theo nhịp tim
    expect((await user.client.delete(`/api/projects/${projectId}`)).status).toBe(204);
    await data.running;
    await expectClean(data);
    expect(await videoUsed(user.id)).toBe(0);
    expect(await storageUsed()).toBe(before);
  }, 90_000);

  it('xóa User', async () => {
    const data = await busyData();
    for (let i = 0; ; i++) {
      try {
        await deleteUserData(user.id);
        break;
      } catch (e) {
        if (!(e instanceof JobsStillRunningError) || i > 100) throw e;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    await data.running;
    await expectClean(data);
  }, 90_000);
});

describe('thu hồi quyền', () => {
  it('vẫn xem, sửa, tải và xóa được dữ liệu đã có; không tạo, xuất hay chạy lại được', async () => {
    const job = await reviewJob(user, projectId);
    const dto = await createExportApi(user, job.id);
    await runExport(dto.id, { spawnRender: fakeBurn({ bytes: 3000 }).spawn });
    await grantVideo(admin, user.id, false);
    expect((await user.client.get(`/api/video/jobs/${job.id}`)).status).toBe(200);
    expect((await user.client.get(`/api/video/jobs/${job.id}/cues`)).status).toBe(200);
    expect((await user.client.get(`/api/video/jobs/${job.id}/subtitles`)).status).toBe(200);
    expect((await user.client.get(`/api/video/exports/${dto.id}/video`)).status).toBe(200);
    expect((await user.client.post(`/api/video/jobs/${job.id}/exports`, { json: { kind: 'burn', format: 'mp4', baseRevision: job.cueRevision } })).status).toBe(403);
    expect((await user.client.post(`/api/video/exports/${dto.id}/rerun`)).status).toBe(403);
    expect((await user.client.post(`/api/video/jobs/${job.id}/source`, { json: { size: job.fileSizeBytes, fingerprint: job.fingerprint } })).status).toBe(403);
    expect((await user.client.delete(`/api/video/exports/${dto.id}`)).status).toBe(204);
    expect(await exportRow(dto.id)).toBeUndefined();
    expect((await user.client.delete(`/api/video/jobs/${job.id}`)).status).toBe(204);
    expect(await videoJobRow(job.id)).toBeUndefined();
    expect(await videoUsed(user.id)).toBe(0);
  }, 60_000);
});
