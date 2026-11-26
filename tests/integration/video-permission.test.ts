import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getCurrentUser } from '@/lib/auth/guards';
import { getDb } from '@/lib/db';
import { users, videoExports, videoJobs } from '@/lib/db/schema';
import { requireVideoPermission, userMayTranslate } from '@/lib/video/permission';
import { stopBoss } from '@/worker/queues';
import { clearRateLimits, createAdmin, createUser, resetDb, type TestUser } from './helpers';
import { errorOf, grantVideo, insertExport, insertVideoJob, videoJobRow } from './video-helpers';
import { newProject } from './voice-helpers';

/** Quyền Dịch Video (spec 006, T011; FR-008). Việc xem, tải, xóa sau khi thu hồi kiểm ở video-deletion.test.ts (T075). */
let admin: TestUser;

beforeAll(async () => {
  await resetDb();
  admin = await createAdmin();
}, 60_000);
afterAll(async () => {
  await stopBoss();
});
beforeEach(clearRateLimits);

const sessionUser = async (u: TestUser) => (await getCurrentUser(new Headers({ cookie: u.client.cookieHeader() })))!;
const exportRow = async (id: string) => (await getDb().select().from(videoExports).where(eq(videoExports.id, id)))[0]!;

describe('quyền mặc định tắt', () => {
  it('User mới không được dùng; Administrator luôn được', async () => {
    const u = await createUser();
    const me = await sessionUser(u);
    expect(me.canTranslateVideo).toBe(false);
    expect(() => requireVideoPermission(me)).toThrow(expect.objectContaining({ status: 403, code: 'VIDEO_NOT_ALLOWED' }));
    expect(await userMayTranslate(u.id)).toBe(false);

    const boss = await sessionUser(admin);
    expect(boss.canTranslateVideo).toBe(false);
    expect(() => requireVideoPermission(boss)).not.toThrow();
    expect(await userMayTranslate(admin.id)).toBe(true);
  });

  it('Administrator bật rồi tắt; User thường không tự bật được', async () => {
    const u = await createUser();
    const self = await u.client.patch(`/api/admin/users/${u.id}`, { json: { canTranslateVideo: true } });
    expect(self.status).toBe(404);
    expect(await userMayTranslate(u.id)).toBe(false);

    const on = await admin.client.patch(`/api/admin/users/${u.id}`, { json: { canTranslateVideo: true } });
    expect(on.status).toBe(200);
    expect(await on.json()).toMatchObject({ id: u.id, canTranslateVideo: true });
    expect(() => requireVideoPermission({ role: 'user', canTranslateVideo: true })).not.toThrow();
    expect(await userMayTranslate(u.id)).toBe(true);
    const list = (await (await admin.client.get('/api/admin/users')).json()) as { items: Array<{ id: string; canTranslateVideo: boolean }> };
    expect(list.items.find((x) => x.id === u.id)?.canTranslateVideo).toBe(true);

    await grantVideo(admin, u.id, false);
    expect(await userMayTranslate(u.id)).toBe(false);
  });

  it('tài khoản bị khóa không còn được dùng dù cờ đang bật; User không tồn tại cũng vậy', async () => {
    const u = await createUser();
    await grantVideo(admin, u.id);
    await getDb().update(users).set({ status: 'banned' }).where(eq(users.id, u.id));
    expect(await userMayTranslate(u.id)).toBe(false);
    expect(await userMayTranslate('00000000-0000-4000-8000-000000000000')).toBe(false);
  });

  it('thân yêu cầu có khóa lạ hoặc kiểu sai → 422', async () => {
    const u = await createUser();
    for (const json of [{ canTranslateVideo: 'yes' }, { canTranslate: true }]) {
      const r = await admin.client.patch(`/api/admin/users/${u.id}`, { json });
      expect(r.status).toBe(422);
      expect((await errorOf(r)).code).toBe('VALIDATION');
    }
  });
});

describe('thu hồi quyền dừng tiến trình đang chạy', () => {
  async function seed() {
    const u = await createUser();
    await grantVideo(admin, u.id);
    const p = await newProject(u);
    const running = await insertVideoJob(u.id, p, { status: 'translating', heartbeatAt: new Date() });
    const queued = await insertVideoJob(u.id, p, { status: 'queued' });
    const interrupted = await insertVideoJob(u.id, p, { status: 'interrupted' });
    const ready = await insertVideoJob(u.id, p, { status: 'review_ready', sourceState: 'ready' });
    const exportJob = await insertVideoJob(u.id, p, { status: 'review_ready', sourceState: 'ready' });
    const exporting = await insertExport(ready.id, u.id, { status: 'running', heartbeatAt: new Date() });
    const waiting = await insertExport(exportJob.id, u.id, { status: 'queued' });
    return { u, running, queued, interrupted, ready, exporting, waiting };
  }

  it.each([
    ['tắt quyền', (id: string) => admin.client.patch(`/api/admin/users/${id}`, { json: { canTranslateVideo: false } })],
    ['khóa tài khoản', (id: string) => admin.client.patch(`/api/admin/users/${id}`, { json: { status: 'banned' } })],
  ])('%s: đang chạy nhận cờ dừng, đang chờ hoặc gián đoạn dừng ngay, kịch bản đã xong giữ nguyên', async (_name, revoke) => {
    const other = await seed();
    const s = await seed();
    expect((await revoke(s.u.id)).status).toBe(200);
    expect(await videoJobRow(s.running.id)).toMatchObject({ status: 'translating', cancelRequested: true });
    expect(await videoJobRow(s.queued.id)).toMatchObject({ status: 'stopped', cancelRequested: false });
    expect(await videoJobRow(s.interrupted.id)).toMatchObject({ status: 'stopped' });
    expect(await videoJobRow(s.ready.id)).toMatchObject({ status: 'review_ready', cancelRequested: false });
    expect(await exportRow(s.exporting.id)).toMatchObject({ status: 'running', cancelRequested: true });
    expect(await exportRow(s.waiting.id)).toMatchObject({ status: 'stopped' });
    // người khác không bị ảnh hưởng
    expect(await videoJobRow(other.running.id)).toMatchObject({ cancelRequested: false });
    expect(await videoJobRow(other.queued.id)).toMatchObject({ status: 'queued' });
    expect(await exportRow(other.waiting.id)).toMatchObject({ status: 'queued' });
    await getDb().delete(videoJobs);
  });

  it('bật lại quyền không dừng gì; đổi quyền khác không dừng video', async () => {
    const s = await seed();
    await grantVideo(admin, s.u.id, true);
    expect((await admin.client.patch(`/api/admin/users/${s.u.id}`, { json: { canUseCustomAi: false } })).status).toBe(200);
    expect(await videoJobRow(s.queued.id)).toMatchObject({ status: 'queued' });
    expect(await videoJobRow(s.running.id)).toMatchObject({ cancelRequested: false });
  });
});
