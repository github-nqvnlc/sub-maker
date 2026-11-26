import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '@/lib/db';
import { systemSettings, users, videoJobs } from '@/lib/db/schema';
import { downloadObjectToFile, headObject } from '@/lib/storage/client';
import { storageKeys } from '@/lib/storage/keys';
import { runVideoPrepare } from '@/worker/jobs/video-prepare';
import { runVideoTranslate, type VideoTranslateOptions } from '@/worker/jobs/video-translate';
import { stopBoss } from '@/worker/queues';
import { sweepStaleVideoJobs } from '@/worker/sweeper';
import { startSonioxMock, type SonioxMock } from '../mocks/soniox-mock';
import { clearRateLimits, createAdmin, createUser, resetDb, type TestUser } from './helpers';
import { putSonioxConfig } from './stt-helpers';
import { errorOf, grantVideo, videoJobRow, videoUsed } from './video-helpers';
import { cuesOf, FAST_PREPARE, FAST_TRANSLATE, runPipeline, uploadedJob, videoLogKeys, videoUsage } from './video-pipeline-helpers';
import { newProject } from './voice-helpers';

/** Phục hồi, dừng, chạy lại, thử lại (spec 006, T031; FR-017, FR-047 đến FR-051, FR-061, SC-011). */
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
  await getDb().delete(videoJobs);
  mock.reset();
  await putSonioxConfig(admin, mock);
  user = await createUser();
  await grantVideo(admin, user.id);
  projectId = await newProject(user);
});

const scenario = (s: string) => putSonioxConfig(admin, mock, s);
const posts = (path: string) => mock.requests.filter((r) => r.method === 'POST' && r.path === path).length;
const okUsage = async (id: string) => (await videoUsage(id)).filter((u) => u.ok).length;
const sweep = () => sweepStaleVideoJobs({ staleMs: 0, lostMs: 3_600_000, prepare: async () => undefined, translate: async () => undefined, preview: async () => undefined });
const setStatus = (id: string, status: 'interrupted') => getDb().update(videoJobs).set({ status, heartbeatAt: null }).where(eq(videoJobs.id, id));

/** Mô phỏng worker chết ngay tại một mốc: lượt đang chạy mất quyền giữ việc rồi văng lỗi, không dọn gì. */
const crashAt = (id: string, stage: Parameters<NonNullable<VideoTranslateOptions['onStage']>>[0]): VideoTranslateOptions => ({
  ...FAST_TRANSLATE,
  onStage: async (s) => {
    if (s !== stage) return;
    await setStatus(id, 'interrupted');
    throw new Error('worker chết');
  },
});

describe('tắt giữa từng giai đoạn rồi chạy tiếp', () => {
  it.each(['uploaded', 'started', 'transcript-saved', 'billed', 'cues-saved'] as const)('chết sau mốc %s: không tải lại, không tạo lại, đúng một bản tính phí', async (stage) => {
    const job = await uploadedJob(user, projectId);
    await runVideoPrepare(job.id, FAST_PREPARE);
    await runVideoTranslate(job.id, crashAt(job.id, stage));
    expect((await videoJobRow(job.id))!.status).toBe('interrupted');
    await runVideoTranslate(job.id, FAST_TRANSLATE);
    expect(await videoJobRow(job.id)).toMatchObject({ status: 'review_ready', cueCount: 3, sonioxFileId: null, sonioxTranscriptionId: null });
    expect(posts('/v1/files')).toBe(1);
    expect(posts('/v1/transcriptions')).toBe(1);
    expect(await okUsage(job.id)).toBe(1);
    expect(await cuesOf(job.id)).toHaveLength(3);
    expect(mock.deleted.files.size).toBe(1);
    expect(mock.deleted.transcriptions.size).toBe(1);
  });

  it('chết lúc chuẩn bị: sweeper đánh dấu gián đoạn, xếp lại bước chuẩn bị và chạy tới cùng', async () => {
    const job = await uploadedJob(user, projectId);
    const queued: string[] = [];
    // giả lập tiến trình chết: nhận việc rồi không bao giờ có nhịp tim nữa
    await getDb().update(videoJobs).set({ status: 'preparing', attempt: 1, heartbeatAt: new Date(Date.now() - 120_000) }).where(eq(videoJobs.id, job.id));
    const r = await sweepStaleVideoJobs({ prepare: async (id) => queued.push(id), translate: async () => undefined, preview: async () => undefined, lostMs: 3_600_000 });
    expect(r.interrupted).toEqual([job.id]);
    expect(queued).toEqual([job.id]);
    expect(await videoJobRow(job.id)).toMatchObject({ status: 'interrupted', interruptions: 1 });
    await runPipeline(job.id);
    expect((await videoJobRow(job.id))!.status).toBe('review_ready');
    expect(await videoLogKeys(job.id)).toEqual(expect.arrayContaining(['interrupted', 'resumed']));
  });

  it('gián đoạn quá 3 lần thì báo lỗi; đã yêu cầu dừng thì thành đã dừng', async () => {
    const job = await uploadedJob(user, projectId);
    await runVideoPrepare(job.id, FAST_PREPARE);
    for (let i = 1; i <= 4; i++) {
      await getDb().update(videoJobs).set({ status: 'translating', heartbeatAt: new Date(Date.now() - 120_000) }).where(eq(videoJobs.id, job.id));
      const r = await sweep();
      expect(i <= 3 ? r.interrupted : r.failed).toEqual([job.id]);
    }
    expect(await videoJobRow(job.id)).toMatchObject({ status: 'failed', errorCode: 'INTERRUPTED' });
    const rerun = await user.client.post(`/api/video/jobs/${job.id}/rerun`);
    expect(rerun.status).toBe(202);
    expect(await videoJobRow(job.id)).toMatchObject({ status: 'queued', interruptions: 0, errorCode: null });

    await getDb().update(videoJobs).set({ status: 'translating', cancelRequested: true, heartbeatAt: new Date(Date.now() - 120_000) }).where(eq(videoJobs.id, job.id));
    expect((await sweep()).stopped).toEqual([job.id]);
    expect(await videoJobRow(job.id)).toMatchObject({ status: 'stopped', cancelRequested: false });
  });

  it('việc chờ bị mất khỏi hàng đợi được xếp lại đúng bước', async () => {
    const job = await uploadedJob(user, projectId);
    const seen: string[] = [];
    // lùi `updated_at` thay vì đặt ngưỡng 0: đồng hồ CSDL trong Docker có thể lệch đồng hồ máy chạy kiểm thử
    const lost = async () => {
      await getDb().update(videoJobs).set({ updatedAt: new Date(Date.now() - 10 * 60_000) }).where(eq(videoJobs.id, job.id));
      await sweepStaleVideoJobs({ prepare: async (id) => seen.push(`prepare ${id}`), translate: async (id) => seen.push(`translate ${id}`), preview: async () => undefined });
    };
    await lost();
    await runVideoPrepare(job.id, FAST_PREPARE);
    await lost();
    expect(seen.filter((s) => s.endsWith(job.id))).toEqual([`prepare ${job.id}`, `translate ${job.id}`]);
  });
});

describe('dừng và chạy lại', () => {
  it('dừng khi đang chờ: dừng ngay; chạy lại hoàn tất', async () => {
    const job = await uploadedJob(user, projectId);
    expect(await (await user.client.post(`/api/video/jobs/${job.id}/stop`)).json()).toEqual({ status: 'stopped' });
    await runPipeline(job.id);
    expect((await videoJobRow(job.id))!.status).toBe('stopped');
    expect(mock.requests).toHaveLength(0);
    expect((await user.client.post(`/api/video/jobs/${job.id}/stop`)).status).toBe(409);
    expect((await user.client.post(`/api/video/jobs/${job.id}/rerun`)).status).toBe(202);
    await runPipeline(job.id);
    expect((await videoJobRow(job.id))!.status).toBe('review_ready');
  });

  it('dừng khi nhà cung cấp chưa xong: xóa dữ liệu ở đó; chạy lại gọi mới và chỉ tính phí một lần', async () => {
    const job = await uploadedJob(user, projectId);
    await runVideoPrepare(job.id, FAST_PREPARE);
    await scenario('slow-1000');
    const running = runVideoTranslate(job.id, { ...FAST_TRANSLATE, pollMs: 30, maxPollMs: 30 });
    await expect.poll(async () => (await videoJobRow(job.id))!.sonioxTranscriptionId).not.toBeNull();
    expect(await (await user.client.post(`/api/video/jobs/${job.id}/stop`)).json()).toEqual({ status: 'stopping' });
    await running;
    expect(await videoJobRow(job.id)).toMatchObject({ status: 'stopped', errorCode: null, sonioxFileId: null, sonioxTranscriptionId: null });
    expect(mock.deleted.transcriptions.size).toBe(1);
    expect(await okUsage(job.id)).toBe(0);
    await scenario('ok');
    expect((await user.client.post(`/api/video/jobs/${job.id}/rerun`)).status).toBe(202);
    await runVideoTranslate(job.id, FAST_TRANSLATE);
    expect((await videoJobRow(job.id))!.status).toBe('review_ready');
    expect(posts('/v1/transcriptions')).toBe(2);
    expect(await okUsage(job.id)).toBe(1);
  }, 60_000);

  it('dừng sau khi nhà cung cấp đã xong: lưu kết quả trước khi xóa; chạy lại không gọi lại', async () => {
    const job = await uploadedJob(user, projectId);
    await runVideoPrepare(job.id, FAST_PREPARE);
    await runVideoTranslate(job.id, {
      ...FAST_TRANSLATE,
      onStage: async (s) => {
        if (s !== 'transcript-saved') return;
        await user.client.post(`/api/video/jobs/${job.id}/stop`);
        await new Promise((r) => setTimeout(r, 300)); // cho nhịp tim thấy yêu cầu dừng
      },
    });
    expect(await videoJobRow(job.id)).toMatchObject({ status: 'stopped', sonioxTranscriptionId: null, billedRun: 1 });
    expect(await headObject(storageKeys.videoTranscript(user.id, job.id, 1))).not.toBeNull();
    expect(await okUsage(job.id)).toBe(1);
    const calls = mock.requests.length;
    expect((await user.client.post(`/api/video/jobs/${job.id}/rerun`)).status).toBe(202);
    await runVideoTranslate(job.id, FAST_TRANSLATE);
    expect((await videoJobRow(job.id))!.status).toBe('review_ready');
    expect(mock.requests.length).toBe(calls);
    expect(await okUsage(job.id)).toBe(1);
    expect(await videoLogKeys(job.id)).toContain('reuseResult');
  });

  it('dừng việc bị gián đoạn còn dữ liệu ở nhà cung cấp: lấy kết quả đã xong rồi xóa', async () => {
    const job = await uploadedJob(user, projectId);
    await runVideoPrepare(job.id, FAST_PREPARE);
    await runVideoTranslate(job.id, crashAt(job.id, 'started'));
    expect((await videoJobRow(job.id))!.sonioxTranscriptionId).not.toBeNull();
    await user.client.post(`/api/video/jobs/${job.id}/stop`);
    expect(await videoJobRow(job.id)).toMatchObject({ status: 'stopped', sonioxFileId: null, sonioxTranscriptionId: null, billedRun: 1 });
    expect(await okUsage(job.id)).toBe(1);
    expect(mock.deleted.files.size).toBe(1);
  });

  it('xóa việc khi đang dịch: tiến trình dừng, dữ liệu ở nhà cung cấp và mọi tệp bị xóa, trả cả hai hạn mức', async () => {
    const job = await uploadedJob(user, projectId);
    await runVideoPrepare(job.id, FAST_PREPARE);
    await scenario('slow-1000');
    const running = runVideoTranslate(job.id, { ...FAST_TRANSLATE, pollMs: 30, maxPollMs: 30 });
    await expect.poll(async () => (await videoJobRow(job.id))!.sonioxTranscriptionId).not.toBeNull();
    expect((await user.client.delete(`/api/video/jobs/${job.id}`)).status).toBe(204);
    await running;
    expect(await videoJobRow(job.id)).toBeUndefined();
    expect(mock.deleted.files.size).toBe(1);
    expect(mock.deleted.transcriptions.size).toBe(1);
    expect(await headObject(storageKeys.videoAudio(user.id, job.id))).toBeNull();
    expect(await videoUsed(user.id)).toBe(0);
  }, 60_000);

  it('chạy lại cần quyền; việc đang chạy hoặc đã xong không chạy lại được', async () => {
    const job = await uploadedJob(user, projectId);
    expect((await user.client.post(`/api/video/jobs/${job.id}/rerun`)).status).toBe(409);
    await user.client.post(`/api/video/jobs/${job.id}/stop`);
    await grantVideo(admin, user.id, false);
    const denied = await user.client.post(`/api/video/jobs/${job.id}/rerun`);
    expect((await errorOf(denied)).code).toBe('VIDEO_NOT_ALLOWED');
  });

  it('thu hồi quyền giữa chừng: tiến trình dừng với lý do rõ', async () => {
    const job = await uploadedJob(user, projectId);
    await runVideoPrepare(job.id, FAST_PREPARE);
    await scenario('slow-1000');
    const running = runVideoTranslate(job.id, { ...FAST_TRANSLATE, pollMs: 30, maxPollMs: 30 });
    await expect.poll(async () => (await videoJobRow(job.id))!.status).toBe('translating');
    await grantVideo(admin, user.id, false);
    await running;
    expect((await videoJobRow(job.id))!.status).toBe('stopped');
  }, 60_000);
});

describe('lỗi tạm và lỗi vĩnh viễn', () => {
  it('Soniox 429 được thử lại rồi thành công', async () => {
    const job = await uploadedJob(user, projectId);
    await scenario('429-3');
    await runPipeline(job.id);
    expect((await videoJobRow(job.id))!.status).toBe('review_ready');
  });

  it('Soniox 503 mãi: thử tối đa 3 lần cho lệnh đó rồi báo lỗi', async () => {
    const job = await uploadedJob(user, projectId);
    await scenario('5xx');
    await runPipeline(job.id);
    expect(await videoJobRow(job.id)).toMatchObject({ status: 'failed', errorCode: 'SONIOX_UNAVAILABLE' });
    expect(posts('/v1/files')).toBe(4);
    expect((await videoUsage(job.id)).filter((u) => !u.ok)).toHaveLength(4);
  });

  it.each([
    ['401', 'SONIOX_AUTH', '/v1/files'],
    ['402', 'SONIOX_QUOTA', '/v1/transcriptions'],
    ['fail', 'SONIOX_FAILED', '/v1/transcriptions'],
  ])('lỗi vĩnh viễn %s → %s, không thử lại', async (s, code, path) => {
    const job = await uploadedJob(user, projectId);
    await scenario(s);
    await runPipeline(job.id);
    expect(await videoJobRow(job.id)).toMatchObject({ status: 'failed', errorCode: code });
    expect(posts(path)).toBe(1);
    expect(await okUsage(job.id)).toBe(0);
  });

  it('tệp hỏng: lỗi vĩnh viễn, tải nguồn đúng một lần, tệp bị bỏ và trả dung lượng', async () => {
    const job = await uploadedJob(user, projectId, { video: Buffer.alloc(40_000, 3) });
    let downloads = 0;
    await runVideoPrepare(job.id, {
      ...FAST_PREPARE,
      download: async (k, f) => {
        downloads++;
        await downloadObjectToFile(k, f);
      },
    });
    expect(await videoJobRow(job.id)).toMatchObject({ status: 'failed', errorCode: 'SOURCE_UNREADABLE', sourceState: 'rejected' });
    expect(downloads).toBe(1);
    expect(await videoUsed(user.id)).toBe(0);
  });

  it('kho lưu tệp lỗi khi chuẩn bị: lỗi tạm, thử lại rồi thành công; lỗi mãi thì dừng sau 3 lần thử lại', async () => {
    const flaky = await uploadedJob(user, projectId);
    let n = 0;
    await runVideoPrepare(flaky.id, {
      ...FAST_PREPARE,
      download: async (k, f) => {
        if (++n <= 2) throw new Error('ECONNRESET');
        await downloadObjectToFile(k, f);
      },
    });
    expect(n).toBe(3);
    expect(await videoJobRow(flaky.id)).toMatchObject({ status: 'queued', progressPercent: 10 });

    // xóa thẳng bản ghi để bắt đầu lại: bộ đếm hạn mức video cũng đặt lại
    await getDb().delete(videoJobs);
    await getDb().update(users).set({ videoUsedBytes: 0 }).where(eq(users.id, user.id));
    const broken = await uploadedJob(user, projectId);
    let m = 0;
    await runVideoPrepare(broken.id, {
      ...FAST_PREPARE,
      download: async () => {
        m++;
        throw new Error('ECONNRESET');
      },
    });
    expect(m).toBe(4);
    expect(await videoJobRow(broken.id)).toMatchObject({ status: 'failed', errorCode: 'STORAGE_UNAVAILABLE', sourceState: 'checking' });
    // lỗi tạm không bỏ video: chạy lại được
    expect(await videoUsed(user.id)).toBe(broken.size);
  });

  it('hết đĩa tạm: lỗi vĩnh viễn, không thử lại', async () => {
    const job = await uploadedJob(user, projectId);
    let asked = 0;
    await runVideoPrepare(job.id, {
      ...FAST_PREPARE,
      freeBytes: async () => {
        asked++;
        return 1000;
      },
    });
    expect(asked).toBe(1);
    expect(await videoJobRow(job.id)).toMatchObject({ status: 'failed', errorCode: 'DISK_FULL' });
  });

  it('kho lỗi khi dịch: thử lại rồi báo lỗi tạm, không gọi nhà cung cấp', async () => {
    const job = await uploadedJob(user, projectId);
    await runVideoPrepare(job.id, FAST_PREPARE);
    let n = 0;
    await runVideoTranslate(job.id, {
      ...FAST_TRANSLATE,
      storage: {
        download: async () => {
          n++;
          throw new Error('ECONNRESET');
        },
      },
    });
    expect(n).toBe(4);
    expect(await videoJobRow(job.id)).toMatchObject({ status: 'failed', errorCode: 'STORAGE_UNAVAILABLE' });
    expect(mock.requests).toHaveLength(0);
  });
});
