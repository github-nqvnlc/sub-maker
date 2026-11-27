import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '@/lib/db';
import { subtitleFiles, systemSettings, users, videoExports, videoJobs } from '@/lib/db/schema';
import { headObject } from '@/lib/storage/client';
import { stopBoss } from '@/worker/queues';
import { startSonioxMock, type SonioxMock } from '../mocks/soniox-mock';
import { clearRateLimits, createAdmin, createUser, resetDb, type TestUser } from './helpers';
import { putSonioxConfig } from './stt-helpers';
import { createExportApi, exportRow, fakeBurn, postExport, reviewJob, runExport } from './video-export-helpers';
import { errorOf, grantVideo, videoJobRow, videoUsed } from './video-helpers';
import { newProject } from './voice-helpers';

/** API bản xuất, tệp phụ đề và "lưu thành kịch bản" (spec 006, US3; FR-039, FR-040, FR-042, FR-043, FR-045, FR-054). */
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

const estimate = async (jobId: string, who = user) => who.client.post(`/api/video/jobs/${jobId}/exports/estimate`, { json: {} });
const completed = async (jobId: string, bytes = 5000) => {
  const dto = await createExportApi(user, jobId);
  await runExport(dto.id, { spawnRender: fakeBurn({ bytes }).spawn });
  return (await exportRow(dto.id))!;
};

describe('ước tính và tạo bản xuất', () => {
  it('ước tính nêu dung lượng, thời gian, kích thước; không giữ chỗ', async () => {
    const job = await reviewJob(user, projectId);
    const res = await estimate(job.id);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ blocked: null, width: 320, height: 180, revision: job.cueRevision, warnings: [] });
    expect(body.estimatedBytes).toBeGreaterThan(1_000_000);
    expect(body.estimatedSeconds).toBeGreaterThan(0);
    expect(await getDb().select().from(videoExports)).toHaveLength(0);
  });

  it('chặn kèm lý do: không có quyền, nguồn đã xóa hoặc đang kiểm, phiên bản cũ, đang có bản xuất, thiếu hạn mức', async () => {
    const job = await reviewJob(user, projectId);
    const stale = await postExport(user, job.id, { baseRevision: job.cueRevision - 1 });
    expect(await errorOf(stale)).toMatchObject({ code: 'CUE_CONFLICT' });
    expect(
      (await errorOf(await user.client.post(`/api/video/jobs/${job.id}/exports`, { json: { kind: 'layer', format: 'webm', baseRevision: job.cueRevision } }))).code,
    ).toBe('VALIDATION');
    expect(
      (await errorOf(await user.client.post(`/api/video/jobs/${job.id}/exports`, { json: { kind: 'burn', format: 'mov', baseRevision: job.cueRevision } }))).code,
    ).toBe('VALIDATION');

    await getDb().update(videoJobs).set({ sourceState: 'checking' }).where(eq(videoJobs.id, job.id));
    expect((await errorOf(await postExport(user, job.id))).code).toBe('VIDEO_SOURCE_NOT_READY');
    await getDb().update(videoJobs).set({ sourceState: 'deleted' }).where(eq(videoJobs.id, job.id));
    expect((await errorOf(await postExport(user, job.id))).code).toBe('VIDEO_SOURCE_GONE');
    expect((await (await estimate(job.id)).json()).blocked).toBe('VIDEO_SOURCE_GONE');
    await getDb().update(videoJobs).set({ sourceState: 'ready' }).where(eq(videoJobs.id, job.id));

    await getDb().insert(systemSettings).values({ key: 'userVideoQuotaBytes', value: 1024 ** 2 });
    expect((await errorOf(await postExport(user, job.id))).code).toBe('VIDEO_QUOTA_EXCEEDED');
    expect((await (await estimate(job.id)).json()).blocked).toBe('VIDEO_QUOTA_EXCEEDED');
    await getDb().delete(systemSettings);

    await createExportApi(user, job.id);
    expect((await errorOf(await postExport(user, job.id))).code).toBe('VIDEO_EXPORT_RUNNING');
    expect((await (await estimate(job.id)).json()).blocked).toBe('VIDEO_EXPORT_RUNNING');

    await grantVideo(admin, user.id, false);
    expect((await postExport(user, job.id)).status).toBe(403);
    expect((await (await estimate(job.id)).json()).blocked).toBe('VIDEO_NOT_ALLOWED');
  });

  it('bản đang chờ giữ chỗ trong hạn mức và chiếm một lượt việc đang chạy', async () => {
    const job = await reviewJob(user, projectId);
    await createExportApi(user, job.id);
    const tab = await (await user.client.get(`/api/projects/${projectId}/video`)).json();
    expect(tab.quota.reservedBytes).toBeGreaterThan(1_000_000);
    expect(tab.quota.activeJobs).toBe(1);
    const [listed] = await (await user.client.get(`/api/projects/${projectId}/video/jobs`)).json();
    expect(listed).toMatchObject({ displayStatus: 'queued', progressPercent: 50, canStop: true });
  });

  it('nhiều yêu cầu xuất đồng thời sát hạn mức: không lần nào vượt (SC-015)', async () => {
    await getDb().insert(systemSettings).values({ key: 'videoMaxJobsPerUser', value: 5 });
    const jobs = [await reviewJob(user, projectId), await reviewJob(user, projectId), await reviewJob(user, projectId)];
    const { estimatedBytes } = await (await estimate(jobs[0]!.id)).json();
    // đủ chỗ cho đúng một bản xuất
    const quota = (await videoUsed(user.id)) + Math.floor(estimatedBytes * 1.5);
    await getDb().insert(systemSettings).values({ key: 'userVideoQuotaBytes', value: quota });
    const results = await Promise.all(jobs.map((j) => postExport(user, j.id)));
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    expect(await getDb().select().from(videoExports)).toHaveLength(1);
  });

  it('dừng bản đang chờ: dừng ngay', async () => {
    const job = await reviewJob(user, projectId);
    const dto = await createExportApi(user, job.id);
    expect(await (await user.client.post(`/api/video/exports/${dto.id}/stop`)).json()).toEqual({ status: 'stopped' });
    expect((await user.client.post(`/api/video/exports/${dto.id}/stop`)).status).toBe(409);
    await runExport(dto.id, { spawnRender: fakeBurn().spawn });
    expect((await exportRow(dto.id))!.status).toBe('stopped');
  });
});

describe('tải về và xóa', () => {
  it('tải thành phẩm có Range, đặt tên tệp, giữ thẻ lượt tải', async () => {
    const job = await reviewJob(user, projectId);
    const row = await completed(job.id);
    const whole = await user.client.get(`/api/video/exports/${row.id}/video`);
    expect(whole.status).toBe(200);
    expect(whole.headers.get('content-type')).toBe('video/mp4');
    expect(whole.headers.get('content-disposition')).toContain('phim-phu-de.mp4');
    expect((await whole.arrayBuffer()).byteLength).toBe(5000);
    const part = await user.client.get(`/api/video/exports/${row.id}/video`, { headers: { range: 'bytes=100-199' } });
    expect(part.status).toBe(206);
    expect((await part.arrayBuffer()).byteLength).toBe(100);
    expect((await exportRow(row.id))!.downloadLeaseUntil!.getTime()).toBeGreaterThan(Date.now() + 60_000);
  });

  it('chưa xong thì không tải được; quá hạn báo VIDEO_EXPORT_EXPIRED', async () => {
    const job = await reviewJob(user, projectId);
    const dto = await createExportApi(user, job.id);
    expect((await user.client.get(`/api/video/exports/${dto.id}/video`)).status).toBe(409);
    await runExport(dto.id, { spawnRender: fakeBurn().spawn });
    await getDb().update(videoExports).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(videoExports.id, dto.id));
    expect((await errorOf(await user.client.get(`/api/video/exports/${dto.id}/video`))).code).toBe('VIDEO_EXPORT_EXPIRED');
  });

  it('xóa một bản xuất trả dung lượng, xóa tệp, tính lại hạn giữ video nguồn', async () => {
    const job = await reviewJob(user, projectId);
    const used = await videoUsed(user.id);
    const row = await completed(job.id, 7000);
    expect(await videoUsed(user.id)).toBe(used + 7000);
    expect((await user.client.delete(`/api/video/exports/${row.id}`)).status).toBe(204);
    expect(await exportRow(row.id)).toBeUndefined();
    expect(await headObject(row.outputKey!)).toBeNull();
    expect(await videoUsed(user.id)).toBe(used);
    const after = (await videoJobRow(job.id))!;
    expect(after.sourceExpiresAt!.getTime() - after.lastActivityAt.getTime()).toBe(7 * 24 * 3600_000);
  });
});

describe('tệp phụ đề', () => {
  it('tải .srt và .vtt theo ba nội dung, đúng tên tệp; không cần quyền', async () => {
    const job = await reviewJob(user, projectId);
    await grantVideo(admin, user.id, false);
    const srt = await user.client.get(`/api/video/jobs/${job.id}/subtitles?format=srt`);
    expect(srt.status).toBe(200);
    expect(srt.headers.get('content-disposition')).toContain('phim.vi.srt');
    expect(await srt.text()).toContain('00:00:00,120 --> 00:00:01,180\nXin chào mọi người.');
    const vtt = await user.client.get(`/api/video/jobs/${job.id}/subtitles?format=vtt&content=bilingual`);
    expect(vtt.headers.get('content-type')).toContain('text/vtt');
    expect(vtt.headers.get('content-disposition')).toContain('phim.en-vi.vtt');
    expect(await vtt.text()).toContain('Hello everyone.\nXin chào mọi người.');
    const source = await user.client.get(`/api/video/jobs/${job.id}/subtitles?content=source`);
    expect(await source.text()).not.toContain('Xin chào');
    expect((await user.client.get(`/api/video/jobs/${job.id}/subtitles?format=ass`)).status).toBe(422);
  });

  it('chương trình khác đọc được cả hai định dạng với đủ số đoạn', async () => {
    const job = await reviewJob(user, projectId);
    const dir = await mkdtemp(path.join(os.tmpdir(), 'sub-'));
    try {
      for (const format of ['srt', 'vtt']) {
        const file = path.join(dir, `p.${format}`);
        await writeFile(file, await (await user.client.get(`/api/video/jobs/${job.id}/subtitles?format=${format}&content=bilingual`)).text());
        const out = execFileSync(process.env.FFPROBE_PATH || 'ffprobe', ['-v', 'error', '-count_packets', '-show_entries', 'stream=codec_name,nb_read_packets', '-of', 'csv=p=0', file], { encoding: 'utf8' });
        expect(out.trim()).toBe(`${format === 'srt' ? 'subrip' : 'webvtt'},3`);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('lưu thành kịch bản của Project: có mốc, dùng được cho voice và overlay; vượt giới hạn kịch bản bị từ chối', async () => {
    const job = await reviewJob(user, projectId);
    const res = await user.client.post(`/api/video/jobs/${job.id}/to-script`, { json: {} });
    expect(res.status).toBe(201);
    const [file] = await getDb().select().from(subtitleFiles).where(eq(subtitleFiles.projectId, projectId));
    expect(file).toMatchObject({ originalName: 'phim.vi.srt', ext: 'srt', hasTimecodes: true, cueCount: 3 });
    await getDb().insert(systemSettings).values({ key: 'maxFileBytes', value: 50 });
    expect((await errorOf(await user.client.post(`/api/video/jobs/${job.id}/to-script`, { json: {} }))).code).toBe('FILE_TOO_LARGE');
  });

  it('chưa có phụ đề thì không có tệp', async () => {
    const job = await reviewJob(user, projectId);
    await getDb().update(videoJobs).set({ cueCount: 0 }).where(eq(videoJobs.id, job.id));
    await getDb().execute(`delete from video_cues where job_id = '${job.id}'` as never);
    expect((await errorOf(await user.client.get(`/api/video/jobs/${job.id}/subtitles`))).code).toBe('VIDEO_NO_CUES');
  });
});
