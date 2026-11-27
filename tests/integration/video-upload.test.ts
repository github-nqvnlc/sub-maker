import { createHash, randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '@/lib/db';
import { systemSettings, videoJobs, videoUploadParts, videoUploads } from '@/lib/db/schema';
import { updateSettings } from '@/lib/settings';
import { getObjectBuffer, headObject, listMultipartUploads } from '@/lib/storage/client';
import { storageKeys } from '@/lib/storage/keys';
import { fingerprintOf } from '@/lib/video/fingerprint';
import { videoQuotaInfo } from '@/lib/video/quota';
import { runVideoRetention } from '@/lib/video/retention';
import { runVideoPrepare } from '@/worker/jobs/video-prepare';
import { stopBoss } from '@/worker/queues';
import { sweepExpiredVideoUploads } from '@/worker/sweeper';
import { startSonioxMock, type SonioxMock } from '../mocks/soniox-mock';
import { clearRateLimits, createAdmin, createUser, resetDb, TestClient, type TestUser } from './helpers';
import { putSonioxConfig } from './stt-helpers';
import { createVideoJobApi, MB, postVideoJob, putPart, PART, sha256, uploadAll } from './video-api';
import { errorOf, grantVideo, videoJobRow, videoUsed } from './video-helpers';
import { createExportApi, reviewJob } from './video-export-helpers';
import { FAST_PREPARE, sampleVideo } from './video-pipeline-helpers';
import { newProject } from './voice-helpers';

/** Tải video từng phần (spec 006, T028; FR-002, FR-004 đến FR-007, FR-013). */
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
  await getDb().delete(systemSettings);
  await putSonioxConfig(admin, mock);
  user = await createUser();
  await grantVideo(admin, user.id);
  projectId = await newProject(user);
});

const uploadRow = async (id: string) => (await getDb().select().from(videoUploads).where(eq(videoUploads.id, id)))[0];
const parts = (id: string) => getDb().select().from(videoUploadParts).where(eq(videoUploadParts.uploadId, id));
const jobsOf = (ownerId: string) => getDb().select().from(videoJobs).where(eq(videoJobs.ownerId, ownerId));

describe('tạo việc', () => {
  it('trả việc đang tải lên và phiên tải chia phần 16 MB; giữ chỗ đúng dung lượng', async () => {
    const bytes = randomBytes(PART + 1000);
    const r = await createVideoJobApi(user, projectId, bytes, { fileName: 'Phim Hè.MKV', direction: 'vi_to_en' });
    expect(r.upload).toMatchObject({ partSize: PART, partCount: 2 });
    expect(r.job).toMatchObject({ projectId, fileName: 'Phim Hè.MKV', ext: 'mkv', size: bytes.length, direction: 'vi_to_en', status: 'waiting_media', displayStatus: 'waiting_media', sourceState: 'uploading', progressPercent: 0, upload: { id: r.upload.id, receivedBytes: 0 } });
    expect(new Date(r.job.sourceExpiresAt!).getTime()).toBeGreaterThan(Date.now() + 47 * 3600_000);
    expect((await videoQuotaInfo(user.id)).reservedBytes).toBe(bytes.length);
    const row = (await videoJobRow(r.job.id))!;
    expect(row.fingerprint).toHaveLength(64);
    const up = (await uploadRow(r.upload.id))!;
    expect(up.key).toBe(storageKeys.videoSource(user.id, r.job.id, 'mkv'));
    expect(await listMultipartUploads(up.key)).toHaveLength(1);
  });

  const body = { fileName: 'a.mp4', size: 1000, fingerprint: 'a'.repeat(64), direction: 'to_vi' };

  it.each(['mp4', 'mov', 'mkv', 'webm', 'avi', 'flv', 'm4v'])('nhận .%s', async (ext) => {
    expect((await postVideoJob(user, projectId, { ...body, fileName: `a.${ext}` })).status).toBe(201);
  });

  it.each([
    ['a.gif'],
    ['a.mp3'],
    ['a'],
    ['a.mp4.exe'],
  ])('từ chối định dạng %s', async (fileName) => {
    const r = await postVideoJob(user, projectId, { ...body, fileName });
    expect(r.status).toBe(422);
    expect((await errorOf(r)).code).toBe('VIDEO_UNSUPPORTED');
  });

  it.each([
    ['dung lượng 0', { size: 0 }],
    ['dung lượng lẻ', { size: 1.5 }],
    ['mã nhận diện sai dạng', { fingerprint: 'XYZ' }],
    ['hướng dịch lạ', { direction: 'ja_to_vi' }],
    ['tên quá 255 ký tự', { fileName: `${'a'.repeat(252)}.mp4` }],
    ['trường lạ', { ownerId: 'x' }],
  ])('thân yêu cầu có %s → 422', async (_n, over) => {
    expect((await postVideoJob(user, projectId, { ...body, ...over })).status).toBe(422);
    expect(await jobsOf(user.id)).toHaveLength(0);
  });

  it('quá dung lượng cho phép → 413; đúng mức tối đa thì được', async () => {
    await updateSettings({ videoMaxBytes: 200 * MB }, null);
    const r = await postVideoJob(user, projectId, { ...body, size: 200 * MB + 1 });
    expect(r.status).toBe(413);
    expect(await errorOf(r)).toMatchObject({ code: 'VIDEO_TOO_LARGE', fields: { maxBytes: String(200 * MB) } });
    expect((await postVideoJob(user, projectId, { ...body, size: 200 * MB })).status).toBe(201);
  });

  it('chưa cấu hình hoặc đang tắt Soniox → chặn trước khi tải (FR-013)', async () => {
    await admin.client.put('/api/admin/stt-config', { json: { enabled: false } });
    const off = await postVideoJob(user, projectId, body);
    expect(off.status).toBe(409);
    expect((await errorOf(off)).code).toBe('STT_NOT_CONFIGURED');
    await admin.client.delete('/api/admin/stt-config');
    expect((await errorOf(await postVideoJob(user, projectId, body))).code).toBe('STT_NOT_CONFIGURED');
    expect(await jobsOf(user.id)).toHaveLength(0);
  });

  it('không có quyền → 403; Project của người khác → 404; chưa đăng nhập → 401', async () => {
    const other = await createUser();
    const mine = await newProject(other);
    expect((await errorOf(await postVideoJob(other, mine, body))).code).toBe('VIDEO_NOT_ALLOWED');
    await grantVideo(admin, other.id);
    expect((await postVideoJob(other, projectId, body)).status).toBe(404);
    expect((await new TestClient().post(`/api/projects/${projectId}/video/jobs`, { json: body })).status).toBe(401);
  });

  it('thiếu hạn mức → 409 nêu cần giải phóng bao nhiêu; trần hệ thống → VIDEO_SYSTEM_FULL; quá số việc → 429', async () => {
    await updateSettings({ userVideoQuotaBytes: 1024 * MB }, null);
    const big = await postVideoJob(user, projectId, { ...body, size: 1024 * MB + 5 });
    expect(big.status).toBe(409);
    expect(await errorOf(big)).toMatchObject({ code: 'VIDEO_QUOTA_EXCEEDED', fields: { needBytes: '5' } });
    await updateSettings({ userVideoQuotaBytes: 5000 * MB, videoSystemCapBytes: 1024 * MB }, null);
    expect((await errorOf(await postVideoJob(user, projectId, { ...body, size: 1025 * MB }))).code).toBe('VIDEO_SYSTEM_FULL');
    expect((await postVideoJob(user, projectId, body)).status).toBe(201);
    const second = await postVideoJob(user, projectId, body);
    expect(second.status).toBe(429);
    expect((await errorOf(second)).code).toBe('VIDEO_TOO_MANY_JOBS');
  });

  it('từ điển của Project được chụp vào việc; hướng dịch được nhớ cho Project', async () => {
    const r = await createVideoJobApi(user, projectId, randomBytes(100), { direction: 'vi_to_en' });
    expect((await videoJobRow(r.job.id))!.glossary).toEqual([]);
    const tab = (await (await user.client.get(`/api/projects/${projectId}/video`)).json()) as { settings: { direction: string }; allowed: boolean; sttConfigured: boolean };
    expect(tab).toMatchObject({ allowed: true, sttConfigured: true, settings: { direction: 'vi_to_en' } });
  });
});

describe('tải phần và hoàn tất', () => {
  it('tải đủ rồi ghép: đúng nội dung, việc vào hàng đợi, hạn mức tính theo dung lượng thật', async () => {
    const bytes = randomBytes(PART + 4321);
    const { job, upload } = await createVideoJobApi(user, projectId, bytes);
    await uploadAll(user, upload, bytes);
    const done = await user.client.post(`/api/video/uploads/${upload.id}/complete`);
    expect(done.status).toBe(200);
    expect(await done.json()).toMatchObject({ id: job.id, status: 'queued', sourceState: 'checking' });
    const key = storageKeys.videoSource(user.id, job.id, 'mp4');
    expect(sha256(await getObjectBuffer(key))).toBe(sha256(bytes));
    expect(await videoUsed(user.id)).toBe(bytes.length);
    expect((await videoQuotaInfo(user.id)).reservedBytes).toBe(0);
    expect((await uploadRow(upload.id))!.state).toBe('completed');
    const row = (await videoJobRow(job.id))!;
    expect(row).toMatchObject({ sourceKey: key, sourceState: 'checking' });
    expect(row.sourceExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 6 * 24 * 3600_000);

    // gọi lại an toàn: không cộng dung lượng lần hai
    const again = await user.client.post(`/api/video/uploads/${upload.id}/complete`);
    expect(again.status).toBe(200);
    expect(await videoUsed(user.id)).toBe(bytes.length);
    expect((await putPart(user, upload.id, 1, bytes.subarray(0, PART))).status).toBe(409);
  });

  it('thiếu phần → 409 UPLOAD_INCOMPLETE nêu phần còn thiếu', async () => {
    const bytes = randomBytes(2 * PART + 10);
    const { upload } = await createVideoJobApi(user, projectId, bytes);
    expect((await putPart(user, upload.id, 2, bytes.subarray(PART, 2 * PART))).status).toBe(204);
    const r = await user.client.post(`/api/video/uploads/${upload.id}/complete`);
    expect(r.status).toBe(409);
    expect(await errorOf(r)).toMatchObject({ code: 'UPLOAD_INCOMPLETE', fields: { missingParts: '1,3' } });
  });

  it('kiểm dung lượng và mã băm từng phần; số phần ngoài phạm vi', async () => {
    const bytes = randomBytes(PART + 100);
    const { upload } = await createVideoJobApi(user, projectId, bytes);
    const wrongSize = await putPart(user, upload.id, 2, bytes.subarray(PART, PART + 99));
    expect(wrongSize.status).toBe(422);
    expect((await errorOf(wrongSize)).code).toBe('UPLOAD_PART_SIZE');
    expect((await errorOf(await putPart(user, upload.id, 1, bytes.subarray(0, PART + 1)))).code).toBe('UPLOAD_PART_SIZE');
    const wrongHash = await putPart(user, upload.id, 2, bytes.subarray(PART), { hash: sha256(Buffer.from('x')) });
    expect(wrongHash.status).toBe(422);
    expect((await errorOf(wrongHash)).code).toBe('UPLOAD_PART_CHECKSUM');
    expect((await errorOf(await putPart(user, upload.id, 2, bytes.subarray(PART), { hash: '' }))).code).toBe('UPLOAD_PART_CHECKSUM');
    expect((await putPart(user, upload.id, 3, bytes.subarray(PART))).status).toBe(404);
    expect((await putPart(user, upload.id, 0, bytes.subarray(PART))).status).toBe(404);
    expect(await parts(upload.id)).toHaveLength(0);
  });

  it('gửi lại một phần ghi đè; tiếp tục bằng danh sách phần đã nhận; hạn phiên lùi 48 giờ sau phần gần nhất', async () => {
    const bytes = randomBytes(PART + 500);
    const { job, upload } = await createVideoJobApi(user, projectId, bytes);
    await getDb().update(videoUploads).set({ expiresAt: new Date(Date.now() + 60_000) }).where(eq(videoUploads.id, upload.id));
    expect((await putPart(user, upload.id, 2, randomBytes(500))).status).toBe(204);
    expect((await putPart(user, upload.id, 2, bytes.subarray(PART))).status).toBe(204);
    expect((await uploadRow(upload.id))!.expiresAt.getTime()).toBeGreaterThan(Date.now() + 47 * 3600_000);
    expect((await videoJobRow(job.id))!.sourceExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 47 * 3600_000);

    const fingerprint = await fingerprintOf(bytes.length, async (a, b) => bytes.subarray(a, b));
    const state = await user.client.get(`/api/video/uploads/${upload.id}?size=${bytes.length}&fingerprint=${fingerprint}`);
    expect(state.status).toBe(200);
    expect(await state.json()).toMatchObject({ id: upload.id, jobId: job.id, state: 'active', partSize: PART, partCount: 2, parts: [2] });
    expect((await putPart(user, upload.id, 1, bytes.subarray(0, PART))).status).toBe(204);
    expect((await user.client.post(`/api/video/uploads/${upload.id}/complete`)).status).toBe(200);
    expect(sha256(await getObjectBuffer(storageKeys.videoSource(user.id, job.id, 'mp4')))).toBe(sha256(bytes));
  });

  it('chọn tệp khác khi tải tiếp → 409 FILE_MISMATCH', async () => {
    const bytes = randomBytes(5000);
    const { upload } = await createVideoJobApi(user, projectId, bytes);
    for (const query of [`size=5001&fingerprint=${'b'.repeat(64)}`, `size=5000&fingerprint=${'b'.repeat(64)}`]) {
      const r = await user.client.get(`/api/video/uploads/${upload.id}?${query}`);
      expect(r.status).toBe(409);
      expect((await errorOf(r)).code).toBe('FILE_MISMATCH');
    }
  });

  it('nội dung đã tải không khớp mã nhận diện đã khai → FILE_MISMATCH, hủy phiên', async () => {
    const bytes = randomBytes(5000);
    const { job, upload } = await createVideoJobApi(user, projectId, bytes);
    await putPart(user, upload.id, 1, randomBytes(5000));
    const r = await user.client.post(`/api/video/uploads/${upload.id}/complete`);
    expect(r.status).toBe(409);
    expect((await errorOf(r)).code).toBe('FILE_MISMATCH');
    expect(await headObject(storageKeys.videoSource(user.id, job.id, 'mp4'))).toBeNull();
    expect(await videoUsed(user.id)).toBe(0);
    expect(await videoJobRow(job.id)).toBeUndefined();
  });

  it('thu hồi quyền giữa chừng: phần kế tiếp và hoàn tất bị từ chối', async () => {
    const bytes = randomBytes(3000);
    const { upload } = await createVideoJobApi(user, projectId, bytes);
    await grantVideo(admin, user.id, false);
    expect((await errorOf(await putPart(user, upload.id, 1, bytes))).code).toBe('VIDEO_NOT_ALLOWED');
    expect((await errorOf(await user.client.post(`/api/video/uploads/${upload.id}/complete`))).code).toBe('VIDEO_NOT_ALLOWED');
  });

  it('người khác và Administrator không đụng được phiên tải (404)', async () => {
    const bytes = randomBytes(3000);
    const { upload } = await createVideoJobApi(user, projectId, bytes);
    const other = await createUser();
    await grantVideo(admin, other.id);
    for (const who of [other, admin]) {
      expect((await who.client.get(`/api/video/uploads/${upload.id}`)).status).toBe(404);
      expect((await putPart(who, upload.id, 1, bytes)).status).toBe(404);
      expect((await who.client.post(`/api/video/uploads/${upload.id}/complete`)).status).toBe(404);
      expect((await who.client.delete(`/api/video/uploads/${upload.id}`)).status).toBe(404);
    }
    expect((await uploadRow(upload.id))!.state).toBe('active');
  });

  it('quá 8 phần đang nằm trong bộ nhớ → 429 kèm Retry-After', async () => {
    const bytes = randomBytes(3000);
    const { upload } = await createVideoJobApi(user, projectId, bytes);
    const release: Array<() => void> = [];
    const reading = new Set<number>();
    const hanging = Array.from({ length: 8 }, (_, i) =>
      putPart(user, upload.id, 1, bytes, {
        stream: new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new Uint8Array(bytes.subarray(0, 10)));
            release.push(() => {
              c.enqueue(new Uint8Array(bytes.subarray(10)));
              c.close();
            });
          },
          // chỉ được gọi khi máy chủ đã đọc mảnh đầu, tức là yêu cầu đã giữ một chỗ trong bộ nhớ
          pull() {
            reading.add(i);
          },
        }),
      }),
    );
    await expect.poll(() => reading.size, { timeout: 15_000 }).toBe(8);
    const ninth = await putPart(user, upload.id, 1, bytes);
    expect(ninth.status).toBe(429);
    expect(Number(ninth.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await errorOf(ninth)).code).toBe('UPLOAD_BUSY');
    for (const r of release) r();
    expect((await Promise.all(hanging)).map((r) => r.status)).toEqual(Array(8).fill(204));
    expect((await putPart(user, upload.id, 1, bytes)).status).toBe(204);
  });
});

describe('hủy và hết hạn', () => {
  it('hủy phiên của video mới: xóa luôn việc, phiên multipart và trả chỗ', async () => {
    const bytes = randomBytes(PART + 10);
    const { job, upload } = await createVideoJobApi(user, projectId, bytes);
    await putPart(user, upload.id, 1, bytes.subarray(0, PART));
    const key = (await uploadRow(upload.id))!.key;
    expect((await user.client.delete(`/api/video/uploads/${upload.id}`)).status).toBe(204);
    expect(await videoJobRow(job.id)).toBeUndefined();
    expect(await listMultipartUploads(key)).toEqual([]);
    expect((await videoQuotaInfo(user.id)).reservedBytes).toBe(0);
    expect((await user.client.delete(`/api/video/uploads/${upload.id}`)).status).toBe(404);
  });

  it('quá 48 giờ: không nhận phần, không hoàn tất, tải tiếp báo đã đóng', async () => {
    const bytes = randomBytes(3000);
    const { upload } = await createVideoJobApi(user, projectId, bytes);
    await getDb().update(videoUploads).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(videoUploads.id, upload.id));
    for (const r of [await putPart(user, upload.id, 1, bytes), await user.client.post(`/api/video/uploads/${upload.id}/complete`), await user.client.get(`/api/video/uploads/${upload.id}`)]) {
      expect(r.status).toBe(409);
      expect((await errorOf(r)).code).toBe('UPLOAD_CLOSED');
    }
  });

  it('lượt quét dọn phiên quá hạn cùng việc chưa có kịch bản; phiên còn hạn giữ nguyên', async () => {
    const stale = await createVideoJobApi(user, projectId, randomBytes(3000));
    await updateSettings({ videoMaxJobsPerUser: 2 }, null);
    const fresh = await createVideoJobApi(user, projectId, randomBytes(2000));
    const key = (await uploadRow(stale.upload.id))!.key;
    await getDb().update(videoUploads).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(videoUploads.id, stale.upload.id));
    const swept = await sweepExpiredVideoUploads();
    expect(swept.expired).toContain(stale.upload.id);
    expect(swept.expired).not.toContain(fresh.upload.id);
    expect(await videoJobRow(stale.job.id)).toBeUndefined();
    expect(await videoJobRow(fresh.job.id)).toBeDefined();
    expect(await listMultipartUploads(key)).toEqual([]);
    expect((await videoQuotaInfo(user.id)).reservedBytes).toBe(2000);
  });

  it('mã băm phần tính trên đúng nội dung gửi', () => {
    expect(sha256(Buffer.from('abc'))).toBe(createHash('sha256').update('abc').digest('hex'));
  });
});

describe('tải lại video nguồn đã xóa (T073, FR-046)', () => {
  /** Việc đã có kịch bản, video nguồn đã hết hạn giữ. */
  async function expired() {
    mock.reset();
    const bytes = await sampleVideo();
    const job = await reviewJob(user, projectId, bytes);
    await runVideoRetention(new Date(Date.now() + 8 * 24 * 3600_000));
    expect(await videoJobRow(job.id)).toMatchObject({ sourceState: 'deleted', sourceKey: null, status: 'review_ready' });
    return { job, bytes };
  }
  const reupload = async (jobId: string, bytes: Buffer, over: Record<string, unknown> = {}) =>
    user.client.post(`/api/video/jobs/${jobId}/source`, { json: { size: bytes.length, fingerprint: await fingerprintOf(bytes.length, async (a, b) => bytes.subarray(a, b)), ...over } });

  it('tệp khác bị từ chối; đúng tệp thì kiểm rồi xuất tiếp được, không dịch lại', async () => {
    const { job, bytes } = await expired();
    const sent = mock.requests.length;
    for (const over of [{ fingerprint: 'b'.repeat(64) }, { size: bytes.length + 1 }]) {
      const wrong = await reupload(job.id, bytes, over);
      expect(wrong.status).toBe(409);
      expect((await errorOf(wrong)).code).toBe('FILE_MISMATCH');
    }
    const res = await reupload(job.id, bytes);
    expect(res.status).toBe(201);
    const upload = (await res.json()) as { id: string; partSize: number; partCount: number };
    expect((await videoQuotaInfo(user.id)).reservedBytes).toBe(bytes.length);
    expect((await videoJobRow(job.id))!.sourceState).toBe('uploading');
    expect((await reupload(job.id, bytes)).status).toBe(409);

    await uploadAll(user, upload, bytes);
    expect((await user.client.post(`/api/video/uploads/${upload.id}/complete`)).status).toBe(200);
    expect(await videoJobRow(job.id)).toMatchObject({ sourceState: 'checking', status: 'review_ready' });
    await runVideoPrepare(job.id, FAST_PREPARE);
    expect(await videoJobRow(job.id)).toMatchObject({ sourceState: 'ready', status: 'review_ready', cueCount: 3 });
    expect(await videoUsed(user.id)).toBe(bytes.length);
    expect(mock.requests).toHaveLength(sent);
    expect((await createExportApi(user, job.id)).status).toBe('queued');
  }, 60_000);

  it('hủy phiên tải lại: việc và kịch bản còn nguyên, chỗ giữ được trả; việc còn video thì không mở phiên', async () => {
    const { job, bytes } = await expired();
    const upload = (await (await reupload(job.id, bytes)).json()) as { id: string };
    expect((await user.client.delete(`/api/video/uploads/${upload.id}`)).status).toBeLessThan(300);
    expect(await videoJobRow(job.id)).toMatchObject({ sourceState: 'deleted', status: 'review_ready', cueCount: 3 });
    expect((await videoQuotaInfo(user.id)).reservedBytes).toBe(0);
    const fresh = await reviewJob(user, await newProject(user), bytes);
    expect((await reupload(fresh.id, bytes)).status).toBe(409);
  }, 60_000);
});

describe('xóa nhiều (T114, FR-045)', () => {
  const bulk = (who: TestUser, ids: unknown) => who.client.post('/api/video/jobs/bulk-delete', { json: { ids } });

  it('dừng, xóa mọi tệp và phiên tải của các việc được chọn, trả dung lượng; mã của người khác báo không tìm thấy', async () => {
    const done = await reviewJob(user, projectId, await sampleVideo());
    const bytes = randomBytes(PART + 10);
    const sending = await createVideoJobApi(user, projectId, bytes);
    await putPart(user, sending.upload.id, 1, bytes.subarray(0, PART));
    const uploadKey = (await uploadRow(sending.upload.id))!.key;

    const other = await createUser();
    await grantVideo(admin, other.id);
    const theirs = await createVideoJobApi(other, await newProject(other), randomBytes(1000));
    const unknown = '00000000-0000-4000-8000-000000000000';
    // thu hồi quyền vẫn xóa được dữ liệu của mình
    await grantVideo(admin, user.id, false);

    const res = await bulk(user, [done.id, sending.job.id, sending.job.id, theirs.job.id, unknown]);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deleted: string[]; notFound: string[] };
    expect(body.deleted.sort()).toEqual([done.id, sending.job.id].sort());
    expect(body.notFound.sort()).toEqual([theirs.job.id, unknown].sort());
    expect(await jobsOf(user.id)).toEqual([]);
    expect(await videoJobRow(theirs.job.id)).toBeDefined();
    expect(await headObject(done.sourceKey!)).toBeNull();
    expect(await listMultipartUploads(uploadKey)).toEqual([]);
    expect(await videoUsed(user.id)).toBe(0);
    expect((await videoQuotaInfo(user.id)).reservedBytes).toBe(0);
  });

  it.each([
    ['rỗng', []],
    ['quá 100 mã', Array.from({ length: 101 }, () => '00000000-0000-4000-8000-000000000000')],
    ['không phải mã', ['abc']],
  ])('danh sách %s: 422', async (_name, ids) => {
    expect((await bulk(user, ids)).status).toBe(422);
  });

  it('chưa đăng nhập: 401', async () => {
    expect((await new TestClient().post('/api/video/jobs/bulk-delete', { json: { ids: ['00000000-0000-4000-8000-000000000000'] } })).status).toBe(401);
  });
});
