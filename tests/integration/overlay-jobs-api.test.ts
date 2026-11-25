import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '@/lib/db';
import { overlayJobs, systemSettings, voices } from '@/lib/db/schema';
import { updateSettings } from '@/lib/settings';
import { stopBoss } from '@/worker/queues';
import { clearRateLimits, createUser, resetDb, type TestUser } from './helpers';
import { createOverlayJob, makeVoice, overlayConfig, overlayLogKeys, overlayRow, postOverlayJob, uploadSrt } from './overlay-helpers';
import { newProject, uploadScript } from './voice-helpers';

/** Tạo, đọc, dừng, chạy lại, xóa tiến trình xuất qua API (spec 005, T028). */
let user: TestUser;
let projectId: string;
let fileId: string;
let voiceId: string;

beforeAll(async () => {
  await resetDb();
}, 60_000);
afterAll(async () => {
  await stopBoss();
});
beforeEach(async () => {
  await clearRateLimits();
  await getDb().delete(systemSettings);
  user = await createUser();
  projectId = await newProject(user);
  fileId = await uploadSrt(user, projectId);
  voiceId = (await makeVoice(user, projectId, fileId)).voiceId;
});

const code = async (r: Response) => ((await r.json()) as { error: { code: string; fields?: Record<string, string> } }).error;
const list = async () => (await (await user.client.get(`/api/projects/${projectId}/overlay/jobs`)).json()) as Array<Record<string, unknown>>;

describe('tạo tiến trình xuất', () => {
  it('201 với đủ thông tin; nội dung được chốt', async () => {
    const job = await createOverlayJob(user, projectId, { fileId, voiceId, config: overlayConfig({ text: { color: '#ff0000' } }) });
    expect(job).toMatchObject({ status: 'queued', progressPercent: 0, format: 'mp4', errorCode: null, sizeBytes: null, canRerun: false });
    expect(job.config.text.color).toBe('#FF0000');
    const row = (await overlayRow(job.id))!;
    expect(row).toMatchObject({ voiceId, subtitleFileId: fileId, durationMs: 10_000, width: 1080, height: 1920, sourceNames: { voice: 'Voice mẫu', subtitle: 'mau.srt' }, engineVersion: 1 });
    expect(row.cues).toHaveLength(3);
    expect(await overlayLogKeys(job.id)).toEqual(['queued']);

    // sửa cấu hình Project sau đó không đổi job
    await user.client.put(`/api/projects/${projectId}/overlay`, { json: { config: overlayConfig({ aspect: '1:1' }), source: {} } });
    expect((await overlayRow(job.id))!.config.aspect).toBe('9:16');
  });

  it('danh sách và chi tiết không trả cues', async () => {
    const job = await createOverlayJob(user, projectId, { fileId, voiceId });
    const rows = await list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).not.toHaveProperty('cues');
    expect(rows[0]).not.toHaveProperty('ownerId');
    expect(rows[0]).not.toHaveProperty('outputStorageKey');
    const detail = (await (await user.client.get(`/api/overlay/jobs/${job.id}`)).json()) as Record<string, unknown>;
    expect(detail).not.toHaveProperty('cues');
    expect(detail.logs).toEqual([expect.objectContaining({ messageKey: 'queued', level: 'info' })]);
  });

  it('cùng clientRequestId → 200 và chỉ một dòng, kể cả gửi song song', async () => {
    const id = randomUUID();
    const rs = await Promise.all([1, 2, 3].map(() => postOverlayJob(user, projectId, { fileId, voiceId, clientRequestId: id })));
    expect(rs.map((r) => r.status).sort()).toEqual([200, 200, 201]);
    const ids = new Set(await Promise.all(rs.map(async (r) => ((await r.json()) as { id: string }).id)));
    expect(ids.size).toBe(1);
    expect(await list()).toHaveLength(1);
    expect((await postOverlayJob(user, projectId, { fileId, voiceId, clientRequestId: id })).status).toBe(200);
    // cùng id nhưng Project khác → từ chối
    const p2 = await newProject(user);
    expect((await postOverlayJob(user, p2, { fileId, voiceId, clientRequestId: id })).status).toBe(409);
  });

  it('cấu hình sai, thiếu trường, trường lạ → 422', async () => {
    const r = await postOverlayJob(user, projectId, { fileId, voiceId, config: { ...overlayConfig(), format: 'mov' } });
    expect(r.status).toBe(422);
    expect((await code(r)).fields).toHaveProperty('config.format');
    for (const json of [{}, { clientRequestId: randomUUID(), fileId, voiceId }, { clientRequestId: randomUUID(), fileId, voiceId, config: overlayConfig(), ownerId: user.id }]) {
      expect((await user.client.post(`/api/projects/${projectId}/overlay/jobs`, { json })).status).toBe(422);
    }
    expect((await postOverlayJob(user, projectId, { fileId })).status).toBe(422);
    expect(await list()).toHaveLength(0);
  });

  it('phụ đề không có mốc → 409 NO_TIMECODES; không có câu nào hiện được → 422', async () => {
    const txt = await uploadScript(user, projectId, 'Chữ thường.', 'a.txt');
    expect(await code(await postOverlayJob(user, projectId, { fileId: txt.id, voiceId }))).toMatchObject({ code: 'NO_TIMECODES' });
    const late = await uploadSrt(user, projectId, '1\n00:10:00,000 --> 00:10:05,000\nSau khi voice kết thúc.\n', 'tre.srt');
    const r = await postOverlayJob(user, projectId, { fileId: late, voiceId });
    expect(r.status).toBe(422);
    expect((await code(r)).code).toBe('OVERLAY_NO_CUES');
  });

  it('voice dài hơn giới hạn → 422 OVERLAY_TOO_LONG, theo loại nền', async () => {
    await getDb().update(voices).set({ durationMs: 11 * 60_000 }).where(eq(voices.id, voiceId));
    const transparent = overlayConfig({ background: 'transparent', format: 'webm' });
    const r = await postOverlayJob(user, projectId, { fileId, voiceId, config: transparent });
    expect(r.status).toBe(422);
    expect(await code(r)).toMatchObject({ code: 'OVERLAY_TOO_LONG', fields: { maxMinutes: '10' } });
    expect((await postOverlayJob(user, projectId, { fileId, voiceId })).status).toBe(201);
    await updateSettings({ overlayMaxMinutes: 5 }, null);
    expect((await code(await postOverlayJob(user, projectId, { fileId, voiceId }))).fields).toEqual({ maxMinutes: '5' });
  });

  it('tiến trình thứ 3 → 429; Administrator chỉnh giới hạn thì theo giới hạn mới', async () => {
    await createOverlayJob(user, projectId, { fileId, voiceId });
    await createOverlayJob(user, projectId, { fileId, voiceId });
    const r = await postOverlayJob(user, projectId, { fileId, voiceId });
    expect(r.status).toBe(429);
    expect((await code(r)).code).toBe('OVERLAY_TOO_MANY_JOBS');
    await updateSettings({ maxOverlayJobsPerUser: 3 }, null);
    expect((await postOverlayJob(user, projectId, { fileId, voiceId })).status).toBe(201);
  });
});

describe('dừng, chạy lại, tải, xóa', () => {
  it('dừng tiến trình đang chờ; dừng lần nữa → 409', async () => {
    const job = await createOverlayJob(user, projectId, { fileId, voiceId });
    const r = await user.client.post(`/api/overlay/jobs/${job.id}/stop`, { json: {} });
    expect(await r.json()).toEqual({ status: 'stopped' });
    expect((await overlayRow(job.id))!.status).toBe('stopped');
    expect((await user.client.post(`/api/overlay/jobs/${job.id}/stop`, { json: {} })).status).toBe(409);
  });

  it('chạy lại giữ nội dung đã chốt và đặt lại bộ đếm; trạng thái khác → 409', async () => {
    const job = await createOverlayJob(user, projectId, { fileId, voiceId });
    expect((await user.client.post(`/api/overlay/jobs/${job.id}/rerun`, { json: {} })).status).toBe(409);
    await getDb().update(overlayJobs).set({ status: 'failed', errorCode: 'RENDER_CRASHED', interruptions: 4, progressPercent: 40, finishedAt: new Date() }).where(eq(overlayJobs.id, job.id));
    const before = (await overlayRow(job.id))!;
    const r = await user.client.post(`/api/overlay/jobs/${job.id}/rerun`, { json: {} });
    expect(r.status).toBe(200);
    const after = (await overlayRow(job.id))!;
    expect(after).toMatchObject({ status: 'queued', errorCode: null, interruptions: 0, progressPercent: 0, finishedAt: null });
    expect(after.cues).toEqual(before.cues);
    expect(after.config).toEqual(before.config);
  });

  it('chạy lại khi nguồn đã bị xóa → 409 SOURCE_DELETED, canRerun = false; vượt giới hạn → 429', async () => {
    const job = await createOverlayJob(user, projectId, { fileId, voiceId });
    await user.client.post(`/api/overlay/jobs/${job.id}/stop`, { json: {} });
    expect((await list())[0]).toMatchObject({ canRerun: true });
    await createOverlayJob(user, projectId, { fileId, voiceId });
    await createOverlayJob(user, projectId, { fileId, voiceId });
    expect((await user.client.post(`/api/overlay/jobs/${job.id}/rerun`, { json: {} })).status).toBe(429);
    await getDb().update(overlayJobs).set({ voiceId: null }).where(eq(overlayJobs.id, job.id));
    expect((await code(await user.client.post(`/api/overlay/jobs/${job.id}/rerun`, { json: {} }))).code).toBe('SOURCE_DELETED');
    expect((await list()).find((j) => j.id === job.id)).toMatchObject({ canRerun: false });
  });

  it('tải video khi chưa hoàn tất → 404', async () => {
    const job = await createOverlayJob(user, projectId, { fileId, voiceId });
    expect((await user.client.get(`/api/overlay/jobs/${job.id}/video`)).status).toBe(404);
  });

  it('id sai định dạng → 404; xóa hàng loạt trả theo từng id', async () => {
    for (const p of ['/api/overlay/jobs/khong-phai-uuid', '/api/overlay/jobs/khong-phai-uuid/video']) expect((await user.client.get(p)).status).toBe(404);
    const a = await createOverlayJob(user, projectId, { fileId, voiceId });
    const b = await createOverlayJob(user, projectId, { fileId, voiceId });
    const ghost = randomUUID();
    const r = await user.client.post('/api/overlay/jobs/bulk-delete', { json: { ids: [a.id, b.id, ghost] } });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { deleted: string[]; busy: string[]; notFound: string[] };
    expect(body.deleted.sort()).toEqual([a.id, b.id].sort());
    expect(body).toMatchObject({ busy: [], notFound: [ghost] });
    expect(await list()).toEqual([]);
    expect((await user.client.post('/api/overlay/jobs/bulk-delete', { json: { ids: [] } })).status).toBe(422);
  });
});
