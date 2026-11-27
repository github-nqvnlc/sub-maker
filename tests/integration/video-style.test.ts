import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '@/lib/db';
import { videoProjectSettings } from '@/lib/db/schema';
import type { VideoJobDetailDto, VideoProjectSettingsDto } from '@/lib/video/service';
import { DEFAULT_VIDEO_STYLE, type VideoStyle } from '@/lib/video/style';
import { stopBoss } from '@/worker/queues';
import { clearRateLimits, createAdmin, createUser, resetDb, TestClient, type TestUser } from './helpers';
import { errorOf, insertVideoJob, videoJobRow } from './video-helpers';
import { newProject } from './voice-helpers';

/** Lưu kiểu phụ đề của việc và cài đặt dịch video của Project qua API (spec 006, T098; FR-031, FR-054, FR-056). */
let user: TestUser;
let other: TestUser;
let admin: TestUser;
let projectId: string;

beforeAll(async () => {
  await resetDb();
  admin = await createAdmin();
}, 60_000);
afterAll(async () => {
  await stopBoss();
});
beforeEach(async () => {
  await clearRateLimits();
  user = await createUser(); // KHÔNG có quyền Dịch Video: đổi kiểu của dữ liệu đã có không cần quyền
  other = await createUser();
  projectId = await newProject(user);
});

const custom: VideoStyle = {
  ...structuredClone(DEFAULT_VIDEO_STYLE),
  display: 'bilingual',
  font: { family: 'roboto', size: 60, weight: 800 },
  sourceLine: { size: 30, color: '#00FF00', opacity: 70 },
  position: { anchor: 'top', y: 20 },
};

const putStyle = (who: TestUser, jobId: string, style: unknown) => who.client.put(`/api/video/jobs/${jobId}/style`, { json: style });
const putSettings = (who: TestUser, id: string, json: unknown) => who.client.put(`/api/projects/${id}/video/settings`, { json });
const projectStyle = async (id: string) => (await getDb().select().from(videoProjectSettings).where(eq(videoProjectSettings.projectId, id)))[0];

describe('PUT /api/video/jobs/{jobId}/style', () => {
  it('lưu kiểu cho việc và làm kiểu gần nhất của Project; là một hoạt động nên dời hạn xóa video nguồn', async () => {
    const job = await insertVideoJob(user.id, projectId, { status: 'review_ready', sourceState: 'ready' });
    await getDb().execute(sql`update video_jobs set last_activity_at = now() - interval '5 days' where id = ${job.id}`);
    const before = (await videoJobRow(job.id))!;

    const res = await putStyle(user, job.id, custom);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ style: custom, changed: [] });

    const row = (await videoJobRow(job.id))!;
    expect(row.style).toEqual(custom);
    expect(row.lastActivityAt.getTime()).toBeGreaterThan(before.lastActivityAt.getTime());
    expect(Math.abs(row.sourceExpiresAt!.getTime() - row.lastActivityAt.getTime() - 7 * 24 * 3600_000)).toBeLessThan(1000);
    expect((await projectStyle(projectId))!.style).toEqual(custom);

    const detail = (await (await user.client.get(`/api/video/jobs/${job.id}`)).json()) as VideoJobDetailDto;
    expect(detail.style).toEqual(custom);
    const tab = (await (await user.client.get(`/api/projects/${projectId}/video`)).json()) as { settings: VideoProjectSettingsDto };
    expect(tab.settings.style).toEqual(custom);
    // hướng dịch của Project không bị đổi theo
    expect(tab.settings.direction).toBe('to_vi');
  });

  it('tổ hợp không hợp lệ được đưa về mặc định của chế độ và báo trường đã sửa', async () => {
    const job = await insertVideoJob(user.id, projectId);
    const res = await putStyle(user, job.id, { ...custom, font: { family: 'arimo', size: 40, weight: 800 }, sync: 'word', wordEffect: 'active', enter: 'fade' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { style: VideoStyle; changed: string[] };
    expect(body.changed.sort()).toEqual(['enter', 'font.weight', 'wordEffect']);
    expect(body.style).toMatchObject({ font: { weight: 700 }, wordEffect: 'none', enter: 'cut' });
    expect((await videoJobRow(job.id))!.style).toEqual(body.style);
  });

  it.each([
    ['thiếu trường', { display: 'target' }],
    ['ngoài khoảng', { ...custom, maxWidthPct: 101 }],
    ['khóa lạ', { ...custom, extra: true }],
    ['không phải đối tượng', 'x'],
  ])('kiểu sai (%s): 422, không ghi gì', async (_name, bad) => {
    const job = await insertVideoJob(user.id, projectId);
    const res = await putStyle(user, job.id, bad);
    expect(res.status).toBe(422);
    expect((await errorOf(res)).code).toBe('VALIDATION');
    expect(await projectStyle(projectId)).toBeUndefined();
  });

  it('người khác và Administrator nhận 404, chưa đăng nhập nhận 401', async () => {
    const job = await insertVideoJob(user.id, projectId);
    expect((await putStyle(other, job.id, custom)).status).toBe(404);
    expect((await putStyle(admin, job.id, custom)).status).toBe(404);
    expect((await new TestClient().put(`/api/video/jobs/${job.id}/style`, { json: custom })).status).toBe(401);
    expect((await videoJobRow(job.id))!.style).not.toEqual(custom);
    expect(await projectStyle(projectId)).toBeUndefined();
  });
});

describe('PUT /api/projects/{projectId}/video/settings', () => {
  it('chỉ đổi trường được gửi; `style: null` đưa kiểu gần nhất về mặc định', async () => {
    let res = await putSettings(user, projectId, { style: custom });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ direction: 'to_vi', glossary: [], style: custom });

    res = await putSettings(user, projectId, { direction: 'vi_to_en' });
    expect(await res.json()).toEqual({ direction: 'vi_to_en', glossary: [], style: custom });

    res = await putSettings(user, projectId, { style: null });
    expect(await res.json()).toEqual({ direction: 'vi_to_en', glossary: [], style: DEFAULT_VIDEO_STYLE });
    expect((await projectStyle(projectId))!.direction).toBe('vi_to_en');
  });

  it('việc đã có giữ nguyên kiểu của nó', async () => {
    const job = await insertVideoJob(user.id, projectId, { style: custom });
    await putSettings(user, projectId, { style: null });
    expect((await videoJobRow(job.id))!.style).toEqual(custom);
  });

  it.each([
    ['thân rỗng', {}],
    ['hướng dịch lạ', { direction: 'to_fr' }],
    ['khóa lạ', { other: 1 }],
  ])('thân sai (%s): 422', async (_name, bad) => {
    expect((await putSettings(user, projectId, bad)).status).toBe(422);
    expect(await projectStyle(projectId)).toBeUndefined();
  });

  it('Project của người khác trả 404', async () => {
    expect((await putSettings(other, projectId, { direction: 'vi_to_en' })).status).toBe(404);
    expect((await putSettings(admin, projectId, { direction: 'vi_to_en' })).status).toBe(404);
    expect(await projectStyle(projectId)).toBeUndefined();
  });
});
