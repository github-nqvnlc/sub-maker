import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '@/lib/db';
import { systemSettings, users, videoExports, videoJobs, videoUploads } from '@/lib/db/schema';
import { headObject, putObject } from '@/lib/storage/client';
import { storageKeys } from '@/lib/storage/keys';
import { runVideoRetention } from '@/lib/video/retention';
import { stopBoss } from '@/worker/queues';
import { sweepExpiredVideoUploads } from '@/worker/sweeper';
import { startSonioxMock, type SonioxMock } from '../mocks/soniox-mock';
import { clearRateLimits, createAdmin, createUser, resetDb, type TestUser } from './helpers';
import { putSonioxConfig } from './stt-helpers';
import { createVideoJobApi, putPart } from './video-api';
import { createExportApi, exportRow, fakeBurn, reviewJob, runExport } from './video-export-helpers';
import { grantVideo, videoJobRow, videoUsed } from './video-helpers';
import { newProject } from './voice-helpers';

/** Hạn giữ và dọn dữ liệu video (spec 006, T074; FR-054, SC-013). Thời gian được giả bằng tham số "bây giờ" của lượt dọn. */
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
  projectId = await newProject(user);
});

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const later = (ms: number) => new Date(Date.now() + ms);
const exportDone = async (jobId: string, bytes = 5000) => {
  const dto = await createExportApi(user, jobId);
  await runExport(dto.id, { spawnRender: fakeBurn({ bytes }).spawn });
  return (await exportRow(dto.id))!;
};
/** Thêm tệp dẫn xuất (bản xem trước) để kiểm nó đi cùng video nguồn. */
async function addPreview(jobId: string) {
  const key = storageKeys.videoPreview(user.id, jobId);
  await putObject(key, Buffer.alloc(100), 'video/mp4');
  await getDb().update(videoJobs).set({ previewState: 'ready', previewKey: key, previewBytes: 100 }).where(eq(videoJobs.id, jobId));
  return key;
}

describe('video nguồn', () => {
  it('xóa 48 giờ sau lần xuất gần nhất, cùng bản xem trước và âm thanh; phụ đề còn nguyên', async () => {
    const job = await reviewJob(user, projectId);
    const preview = await addPreview(job.id);
    await exportDone(job.id);
    const before = (await videoJobRow(job.id))!;
    const used = await videoUsed(user.id);
    expect((await runVideoRetention(later(47 * HOUR))).sources).toEqual([]);
    expect((await runVideoRetention(later(49 * HOUR))).sources).toEqual([job.id]);
    const row = (await videoJobRow(job.id))!;
    expect(row).toMatchObject({ sourceState: 'deleted', sourceKey: null, sourceExpiresAt: null, previewState: 'none', previewKey: null, previewBytes: null, audioTempKey: null, cueCount: 3 });
    for (const key of [before.sourceKey!, preview, before.audioTempKey!]) expect(await headObject(key)).toBeNull();
    expect(await videoUsed(user.id)).toBe(used - before.fileSizeBytes);
    // lượt sau không làm gì thêm
    expect((await runVideoRetention(later(49 * HOUR))).sources).toEqual([]);
    expect(await videoUsed(user.id)).toBe(used - before.fileSizeBytes);
  });

  it('chưa xuất: xóa sau 7 ngày không hoạt động; sửa phụ đề ở ngày thứ 6 thì ngày thứ 7 chưa xóa', async () => {
    const job = await reviewJob(user, projectId);
    expect((await runVideoRetention(later(6 * DAY))).sources).toEqual([]);
    // giả như đã 6 ngày trôi qua rồi người dùng sửa một cue
    await getDb()
      .update(videoJobs)
      .set({ lastActivityAt: later(-6 * DAY), sourceExpiresAt: later(1 * DAY) })
      .where(eq(videoJobs.id, job.id));
    const [cue] = (await (await user.client.get(`/api/video/jobs/${job.id}/cues`)).json()).cues;
    await user.client.post(`/api/video/jobs/${job.id}/cues/ops`, { json: { baseRevision: job.cueRevision, ops: [{ type: 'update', id: cue.id, patch: { targetText: 'sửa' } }] } });
    expect((await runVideoRetention(later(1.5 * DAY))).sources).toEqual([]);
    expect((await runVideoRetention(later(7.5 * DAY))).sources).toEqual([job.id]);
  });

  it.each([
    ['đang có thẻ giữ lượt phát', { sourceLeaseUntil: new Date(Date.now() + 30 * DAY) }],
    ['pipeline đang chạy', { status: 'translating' as const }],
  ])('%s thì chưa xóa', async (_name, over) => {
    const job = await reviewJob(user, projectId);
    await getDb().update(videoJobs).set(over).where(eq(videoJobs.id, job.id));
    expect((await runVideoRetention(later(8 * DAY))).sources).toEqual([]);
    expect((await videoJobRow(job.id))!.sourceState).toBe('ready');
  });

  it('đang xuất thì chưa xóa', async () => {
    const job = await reviewJob(user, projectId);
    await createExportApi(user, job.id);
    expect((await runVideoRetention(later(8 * DAY))).sources).toEqual([]);
  });
});

describe('thành phẩm, phiên tải dở, token thô', () => {
  it('thành phẩm xóa sau 7 ngày: hết tải được, trả dung lượng, bản ghi còn lại ở trạng thái hết hạn; đang tải thì chờ', async () => {
    const job = await reviewJob(user, projectId);
    const row = await exportDone(job.id, 7000);
    const used = await videoUsed(user.id);
    expect((await runVideoRetention(later(6 * DAY))).exports).toEqual([]);
    await getDb().update(videoExports).set({ downloadLeaseUntil: later(30 * DAY) }).where(eq(videoExports.id, row.id));
    expect((await runVideoRetention(later(8 * DAY))).exports).toEqual([]);
    await getDb().update(videoExports).set({ downloadLeaseUntil: null }).where(eq(videoExports.id, row.id));
    const result = await runVideoRetention(later(8 * DAY));
    expect(result.exports).toEqual([row.id]);
    expect(await exportRow(row.id)).toMatchObject({ status: 'expired', outputKey: null });
    expect(await headObject(row.outputKey!)).toBeNull();
    expect(await videoUsed(user.id)).toBeLessThanOrEqual(used - 7000);
  });

  it('phiên tải dở quá 48 giờ bị hủy cùng việc chưa có phụ đề', async () => {
    const bytes = Buffer.alloc(17 * 1024 * 1024, 7);
    const { job, upload } = await createVideoJobApi(user, projectId, bytes);
    await putPart(user, upload.id, 1, bytes.subarray(0, upload.partSize));
    const row = (await videoJobRow(job.id))!;
    expect(Math.abs(row.sourceExpiresAt!.getTime() - Date.now() - 48 * HOUR)).toBeLessThan(60_000);
    expect((await sweepExpiredVideoUploads()).expired).toEqual([]);
    await getDb().update(videoUploads).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(videoUploads.id, upload.id));
    expect((await sweepExpiredVideoUploads()).expired).toEqual([upload.id]);
    expect(await videoJobRow(job.id)).toBeUndefined();
  });

  it('token thô của lượt dịch không thành công bị dọn sau thời gian không hoạt động', async () => {
    const job = await reviewJob(user, projectId);
    const key = storageKeys.videoTranscript(user.id, job.id, 2);
    await putObject(key, Buffer.from('{}'), 'application/json');
    await getDb()
      .update(videoJobs)
      .set({ status: 'failed', translationRun: 2, lastActivityAt: later(-8 * DAY) })
      .where(eq(videoJobs.id, job.id));
    expect((await runVideoRetention()).transcripts).toEqual([job.id]);
    expect(await headObject(key)).toBeNull();
  });
});
