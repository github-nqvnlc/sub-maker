import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getDb } from '@/lib/db';
import { overlayConfigs } from '@/lib/db/schema';
import { runRenderOverlay } from '@/worker/jobs/render-overlay';
import { stopBoss } from '@/worker/queues';
import { clearRateLimits, createAdmin, createUser, resetDb, TestClient, type TestUser } from './helpers';
import { FAST_RENDER, fakeRender } from './overlay-fake-render';
import { createOverlayJob, makeVoice, overlayConfig, overlayRow, postOverlayJob, uploadSrt } from './overlay-helpers';
import { newProject } from './voice-helpers';

/**
 * Cô lập dữ liệu video overlay (spec 005, FR-045, SC-012, Hiến pháp I, T033). Bộ `tests/isolation` đọc openapi của spec 001 nên đây là
 * nơi phủ mọi route overlay: User khác và Administrator nhận 404 như thể không tồn tại, chưa đăng nhập nhận 401.
 */
let a: TestUser;
let b: TestUser;
let admin: TestUser;
let projectId: string;
let fileId: string;
let voiceId: string;
let doneJob: string;
let queuedJob: string;

beforeAll(async () => {
  await resetDb();
  await clearRateLimits();
  admin = await createAdmin();
  a = await createUser();
  b = await createUser();
  projectId = await newProject(a);
  fileId = await uploadSrt(a, projectId);
  voiceId = (await makeVoice(a, projectId, fileId)).voiceId;
  doneJob = (await createOverlayJob(a, projectId, { fileId, voiceId })).id;
  await runRenderOverlay(doneJob, { ...FAST_RENDER, spawnRender: fakeRender().spawn });
  queuedJob = (await createOverlayJob(a, projectId, { fileId, voiceId })).id;
}, 60_000);
afterAll(async () => {
  await stopBoss();
});

type Call = [method: 'GET' | 'PUT' | 'POST', path: () => string, json?: () => unknown, headers?: Record<string, string>];
const CALLS: Call[] = [
  ['GET', () => `/api/projects/${projectId}/overlay`],
  ['PUT', () => `/api/projects/${projectId}/overlay`, () => ({ config: overlayConfig(), source: {} })],
  ['GET', () => `/api/projects/${projectId}/overlay/timeline?voiceId=${voiceId}&fileId=${fileId}`],
  ['GET', () => `/api/projects/${projectId}/overlay/jobs`],
  ['POST', () => `/api/projects/${projectId}/overlay/jobs`, () => ({ clientRequestId: crypto.randomUUID(), fileId, voiceId, config: overlayConfig() })],
  ['GET', () => `/api/overlay/jobs/${doneJob}`],
  ['GET', () => `/api/overlay/jobs/${doneJob}/video`],
  ['GET', () => `/api/overlay/jobs/${doneJob}/video`, undefined, { range: 'bytes=0-10' }],
  ['POST', () => `/api/overlay/jobs/${queuedJob}/stop`, () => ({})],
  ['POST', () => `/api/overlay/jobs/${queuedJob}/rerun`, () => ({})],
];
const call = (c: TestClient, [method, path, json, headers]: Call) => c.request(method, path(), { json: json?.(), headers });

describe.each(CALLS.map((c) => [`${c[0]} ${c[1].toString().replace(/^\(\) => /, '')}${c[3] ? ' (Range)' : ''}`, c] as const))('%s', (_n, c) => {
  it('User khác và Administrator → 404; chưa đăng nhập → 401', async () => {
    expect((await call(b.client, c)).status).toBe(404);
    expect((await call(admin.client, c)).status).toBe(404);
    expect((await call(new TestClient(), c)).status).toBe(401);
  });
});

describe('không rò rỉ qua đường gián tiếp', () => {
  it('User B dùng voice hoặc phụ đề của A trong Project của mình → 404', async () => {
    const p = await newProject(b);
    const f = await uploadSrt(b, p);
    const v = (await makeVoice(b, p, f)).voiceId;
    expect((await postOverlayJob(b, p, { fileId, voiceId: v })).status).toBe(404);
    expect((await postOverlayJob(b, p, { fileId: f, voiceId })).status).toBe(404);
    expect((await b.client.get(`/api/projects/${p}/overlay/timeline?voiceId=${voiceId}&fileId=${f}`)).status).toBe(404);
  });

  it('xóa hàng loạt id của A: báo không tìm thấy, dữ liệu của A còn nguyên', async () => {
    for (const u of [b, admin]) {
      const r = await u.client.post('/api/overlay/jobs/bulk-delete', { json: { ids: [doneJob, queuedJob] } });
      expect(await r.json()).toEqual({ deleted: [], busy: [], notFound: [doneJob, queuedJob] });
    }
    expect((await overlayRow(doneJob))!.status).toBe('completed');
    expect((await overlayRow(queuedJob))!.status).toBe('queued');
    expect((await new TestClient().post('/api/overlay/jobs/bulk-delete', { json: { ids: [doneJob] } })).status).toBe(401);
  });

  it('các lần gọi bị từ chối không tạo hay sửa dữ liệu', async () => {
    expect(await getDb().select().from(overlayConfigs)).toEqual([]);
    expect((await (await a.client.get(`/api/projects/${projectId}/overlay/jobs`)).json()) as unknown[]).toHaveLength(2);
  });

  it('chủ sở hữu tải được video, có tên tệp sạch và hỗ trợ Range', async () => {
    const full = await a.client.get(`/api/overlay/jobs/${doneJob}/video`);
    expect(full.status).toBe(200);
    expect(full.headers.get('content-type')).toBe('video/mp4');
    expect(full.headers.get('content-disposition')).toContain('mau-overlay.mp4');
    expect(full.headers.get('cache-control')).toContain('private');
    const part = await a.client.get(`/api/overlay/jobs/${doneJob}/video`, { headers: { range: 'bytes=0-99' } });
    expect(part.status).toBe(206);
    expect((await part.arrayBuffer()).byteLength).toBe(100);
  });

  it('thao tác ghi thiếu Origin hợp lệ bị từ chối (CSRF)', async () => {
    expect((await a.client.post(`/api/overlay/jobs/${queuedJob}/stop`, { json: {}, origin: 'https://evil.example' })).status).toBe(403);
    expect((await overlayRow(queuedJob))!.status).toBe('queued');
  });
});
