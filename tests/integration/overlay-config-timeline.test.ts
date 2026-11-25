import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getDb } from '@/lib/db';
import { overlayConfigs } from '@/lib/db/schema';
import { DEFAULT_CONFIG } from '@/lib/overlay/config';
import { stopBoss } from '@/worker/queues';
import { clearRateLimits, createUser, resetDb, type TestUser } from './helpers';
import { createOverlayJob, makeVoice, overlayConfig, SPLIT_FAILED_TIMELINE, uploadSrt, usedBytes } from './overlay-helpers';
import { newProject, uploadScript } from './voice-helpers';

/** Cấu hình gần nhất, giới hạn và mốc áp dụng cho xem trước (spec 005, T027). */
let user: TestUser;
let projectId: string;
let fileId: string;
let voiceId: string;

beforeAll(async () => {
  await resetDb();
  await clearRateLimits();
  user = await createUser();
  projectId = await newProject(user);
  fileId = await uploadSrt(user, projectId);
  voiceId = (await makeVoice(user, projectId, fileId)).voiceId;
}, 60_000);
afterAll(async () => {
  await stopBoss();
});

const state = async () => (await user.client.get(`/api/projects/${projectId}/overlay`)).json() as Promise<{ config: unknown; source: Record<string, unknown>; limits: Record<string, number> }>;
const timeline = (q: Record<string, string>, pid = projectId) => user.client.get(`/api/projects/${pid}/overlay/timeline?${new URLSearchParams(q)}`);

describe('cấu hình gần nhất', () => {
  it('chưa lưu thì trả mặc định và giới hạn đang áp dụng', async () => {
    const s = await state();
    expect(s.config).toEqual(DEFAULT_CONFIG);
    expect(s.source).toEqual({});
    expect(s.limits).toEqual({ maxMinutes: 60, maxMinutesTransparent: 10, maxJobsPerUser: 2, quotaBytes: 524_288_000, usedBytes: await usedBytes(user.id), pendingBytes: 0 });
  });

  it('lưu rồi đọc lại; lưu đè', async () => {
    const config = overlayConfig({ background: 'blue', font: { family: 'inter', size: 90, weight: 800 } });
    const res = await user.client.put(`/api/projects/${projectId}/overlay`, { json: { config, source: { voiceId, fileId } } });
    expect(res.status).toBe(204);
    expect(await state()).toMatchObject({ config, source: { voiceId, fileId, audioId: null } });
    const again = overlayConfig({ aspect: '1:1' });
    await user.client.put(`/api/projects/${projectId}/overlay`, { json: { config: again, source: {} } });
    expect((await state()).config).toEqual(again);
    expect(await getDb().select().from(overlayConfigs).where(eq(overlayConfigs.projectId, projectId))).toHaveLength(1);
  });

  it('cấu hình sai → 422 nêu trường, không lưu; trường lạ và nguồn sai cũng 422', async () => {
    const before = await state();
    const bad = await user.client.put(`/api/projects/${projectId}/overlay`, { json: { config: { ...overlayConfig(), effectMs: 9999 }, source: {} } });
    expect(bad.status).toBe(422);
    expect(((await bad.json()) as { error: { code: string; fields: Record<string, string> } }).error).toMatchObject({ code: 'VALIDATION', fields: { 'config.effectMs': expect.any(String) } });
    expect((await user.client.put(`/api/projects/${projectId}/overlay`, { json: { config: overlayConfig(), source: {}, extra: 1 } })).status).toBe(422);
    expect((await user.client.put(`/api/projects/${projectId}/overlay`, { json: { config: overlayConfig(), source: { voiceId: 'x' } } })).status).toBe(422);
    expect((await state()).config).toEqual(before.config);
  });

  it('pendingBytes là tổng ước tính của tiến trình đang hoạt động', async () => {
    const job = await createOverlayJob(user, projectId, { fileId, voiceId });
    expect((await state()).limits.pendingBytes).toBe(job.estimatedBytes);
    await user.client.post(`/api/overlay/jobs/${job.id}/stop`, { json: {} });
    expect((await state()).limits.pendingBytes).toBe(0);
  });
});

describe('mốc áp dụng', () => {
  type T = { durationMs: number; cues: Array<{ startMs: number; origin: string; text: string }>; warnings: Array<{ code: string }> };
  const get = async (q: Record<string, string>) => (await (await timeline(q)).json()) as T;

  it('voice khớp mốc từ chính tệp: dùng mốc đọc thật', async () => {
    const t = await get({ voiceId, fileId });
    expect(t.durationMs).toBe(10_000);
    expect(t.cues.map((c) => c.startMs)).toEqual([400, 5105, 8872]);
    expect(t.cues.every((c) => c.origin === 'voice')).toBe(true);
    expect(t.warnings).toEqual([]);
  });

  it('câu bị tách và đoạn bị từ chối: chỉ cue lỗi dùng mốc tệp', async () => {
    const v = await makeVoice(user, projectId, fileId, { timeline: SPLIT_FAILED_TIMELINE });
    const t = await get({ voiceId: v.voiceId, fileId });
    expect(t.cues.map((c) => [c.startMs, c.origin])).toEqual([
      [400, 'voice'],
      [5005, 'file'],
      [8872, 'voice'],
    ]);
    expect(t.warnings).toEqual([]);
  });

  it('voice đọc liên tục → cảnh báo NOT_TIMED_VOICE và dùng mốc tệp', async () => {
    const v = await makeVoice(user, projectId, fileId, { timed: false });
    const t = await get({ voiceId: v.voiceId, fileId });
    expect(t.warnings.map((w) => w.code)).toEqual(['NOT_TIMED_VOICE']);
    expect(t.cues[0]!.startMs).toBe(300);
  });

  it('voice của tệp khác → cảnh báo OTHER_FILE', async () => {
    const other = await uploadSrt(user, projectId, undefined, 'khac.srt');
    const t = await get({ voiceId, fileId: other });
    expect(t.warnings.map((w) => w.code)).toEqual(['OTHER_FILE']);
  });

  it('cần đúng một nguồn voice và một phụ đề', async () => {
    const uuid = '00000000-0000-4000-8000-000000000000';
    for (const q of [{ fileId }, { voiceId }, { voiceId, audioId: uuid, fileId }]) expect((await timeline(q as Record<string, string>)).status).toBe(422);
  });

  it('tệp không có mốc → 409 NO_TIMECODES; tệp hoặc voice của Project khác → 404', async () => {
    const txt = await uploadScript(user, projectId, 'Chỉ là chữ thường.', 'a.txt');
    const r = await timeline({ voiceId, fileId: txt.id });
    expect(r.status).toBe(409);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe('NO_TIMECODES');
    const p2 = await newProject(user);
    expect((await timeline({ voiceId, fileId }, p2)).status).toBe(404);
    const f2 = await uploadSrt(user, p2);
    expect((await timeline({ voiceId, fileId: f2 })).status).toBe(404);
  });
});
