import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startMockProvider, type MockProvider } from '../../mock-provider/server';
import { getDb } from '@/lib/db';
import { aiProviderConfigs, jobLogs, users, voiceJobs } from '@/lib/db/schema';
import { runGenerateVoice } from '@/worker/jobs/generate-voice';
import { stopBoss } from '@/worker/queues';
import { TestClient, clearRateLimits, createAdmin, createUser, resetDb, type TestUser } from './helpers';
import { FAST, SCRIPT_4, jobRow, newProject, putGlobalConfig, setScenario, startJob, uploadScript } from './voice-helpers';

let mock: MockProvider;
let admin: TestUser;
let a: TestUser;

type SseEvent = { id?: number; event: string; data: Record<string, unknown> };

/** Đọc luồng SSE cho tới khi `stop` trả true (hoặc hết giờ). Trả các sự kiện đã nhận và hủy luồng. */
async function readSse(res: Response, stop: (events: SseEvent[]) => boolean, maxMs = 20_000): Promise<SseEvent[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const events: SseEvent[] = [];
  let buf = '';
  const deadline = Date.now() + maxMs;
  try {
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buf.indexOf('\n\n')) !== -1) {
        const block = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        const ev: Partial<SseEvent> & { event: string } = { event: 'message' };
        let data = '';
        for (const line of block.split('\n')) {
          if (line.startsWith('id: ')) ev.id = Number(line.slice(4));
          else if (line.startsWith('event: ')) ev.event = line.slice(7);
          else if (line.startsWith('data: ')) data += line.slice(6);
        }
        if (data) events.push({ ...ev, event: ev.event, data: JSON.parse(data) });
      }
      if (stop(events)) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return events;
}

beforeAll(async () => {
  mock = await startMockProvider();
  await resetDb();
  admin = await createAdmin();
});
afterAll(async () => {
  await mock.close();
  await stopBoss();
});
beforeEach(async () => {
  await clearRateLimits();
  mock.reset();
  await getDb().delete(aiProviderConfigs);
  await putGlobalConfig(admin, mock, 'ok');
  a = await createUser({ name: 'Người dùng A' });
});

describe('tạo tiến trình (POST /api/projects/{id}/jobs)', () => {
  it('202: xếp hàng với thiết lập chụp lại, tiến độ 0/tổng, log JOB_QUEUED', async () => {
    const pid = await newProject(a);
    const file = await uploadScript(a, pid, SCRIPT_4);
    const res = await a.client.post(`/api/projects/${pid}/jobs`, { json: { fileId: file.id } });
    expect(res.status).toBe(202);
    const job = await res.json();
    expect(job).toMatchObject({
      status: 'queued',
      providerType: 'fpt_marketplace',
      configScope: 'global',
      progressDone: 0,
      progressTotal: 4,
      settings: { model: 'FPT.AI-VITs', voice: 'banmai' },
      voiceId: null,
    });
    const row = await jobRow(job.id);
    expect(row.queueJobId).toBeTruthy(); // đã vào hàng đợi pg-boss
    const logs = await getDb().select().from(jobLogs).where(eq(jobLogs.jobId, job.id));
    expect(logs.map((l) => l.code)).toEqual(['JOB_QUEUED']);
  });

  it('thiết lập tùy chọn: model/giọng/tốc độ được kiểm tra theo catalog', async () => {
    const pid = await newProject(a);
    const file = await uploadScript(a, pid, SCRIPT_4);
    const ok = await a.client.post(`/api/projects/${pid}/jobs`, { json: { fileId: file.id, model: 'FPT.TTS-pro', voice: 'std_banmai', speed: 1.1 } });
    expect(ok.status).toBe(202);
    expect((await ok.json()).settings).toEqual({ timing: null, model: 'FPT.TTS-pro', voice: 'std_banmai', speed: 1.1 });

    for (const [json, field] of [
      [{ voice: 'khong-co' }, 'voice'],
      [{ model: 'model-la' }, 'model'],
      [{ model: 'FPT.TTS-pro', voice: 'banmai' }, 'voice'], // giọng không dùng chéo model
      [{ speed: 5 }, 'speed'],
    ] as const) {
      const res = await a.client.post(`/api/projects/${pid}/jobs`, { json: { fileId: file.id, ...json } });
      expect(res.status, JSON.stringify(json)).toBe(422);
      expect(Object.keys((await res.json()).error.fields)).toContain(field);
    }
  });

  it('chưa có cấu hình nhà cung cấp khả dụng → 409 PROVIDER_NOT_CONFIGURED', async () => {
    await getDb().delete(aiProviderConfigs);
    const pid = await newProject(a);
    const file = await uploadScript(a, pid, SCRIPT_4);
    const res = await a.client.post(`/api/projects/${pid}/jobs`, { json: { fileId: file.id } });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('PROVIDER_NOT_CONFIGURED');
    expect(await getDb().select().from(voiceJobs).where(eq(voiceJobs.projectId, pid))).toHaveLength(0);
  });

  it('hết dung lượng lưu trữ → 409 QUOTA_EXCEEDED', async () => {
    const pid = await newProject(a);
    const file = await uploadScript(a, pid, SCRIPT_4);
    await getDb().update(users).set({ storageUsedBytes: 524288000 }).where(eq(users.id, a.id));
    const res = await a.client.post(`/api/projects/${pid}/jobs`, { json: { fileId: file.id } });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('QUOTA_EXCEEDED');
  });

  it('fileId của Project khác hoặc của User khác → 404; thiếu/sai fileId → 422', async () => {
    const p1 = await newProject(a);
    const p2 = await newProject(a);
    const f1 = await uploadScript(a, p1, SCRIPT_4);
    expect((await a.client.post(`/api/projects/${p2}/jobs`, { json: { fileId: f1.id } })).status).toBe(404);

    const b = await createUser();
    expect((await b.client.post(`/api/projects/${p1}/jobs`, { json: { fileId: f1.id } })).status).toBe(404);
    const pb = await newProject(b);
    expect((await b.client.post(`/api/projects/${pb}/jobs`, { json: { fileId: f1.id } })).status).toBe(404);

    expect((await a.client.post(`/api/projects/${p1}/jobs`, { json: {} })).status).toBe(422);
    expect((await a.client.post(`/api/projects/${p1}/jobs`, { json: { fileId: 'x' } })).status).toBe(422);
  });
});

describe('đọc tiến trình và log', () => {
  it('danh sách theo Project, chi tiết, và danh sách của tôi xuyên Project có lọc trạng thái', async () => {
    const p1 = await newProject(a, 'P1');
    const p2 = await newProject(a, 'P2');
    const j1 = await startJob(a, p1, (await uploadScript(a, p1, SCRIPT_4)).id);
    const j2 = await startJob(a, p2, (await uploadScript(a, p2, SCRIPT_4)).id);
    await runGenerateVoice(j2.id, FAST);

    const byProject = (await (await a.client.get(`/api/projects/${p1}/jobs`)).json()) as Array<{ id: string }>;
    expect(byProject.map((j) => j.id)).toEqual([j1.id]);

    const detail = await (await a.client.get(`/api/jobs/${j2.id}`)).json();
    expect(detail).toMatchObject({ id: j2.id, status: 'completed', progressDone: 4, failedSegments: [] });
    expect(detail.voiceId).toBeTruthy();

    const all = (await (await a.client.get('/api/jobs')).json()) as Array<{ id: string }>;
    expect(all.map((j) => j.id).sort()).toEqual([j1.id, j2.id].sort());
    const active = (await (await a.client.get('/api/jobs?status=running,queued')).json()) as Array<{ id: string }>;
    expect(active.map((j) => j.id)).toEqual([j1.id]);
    expect((await a.client.get('/api/jobs?status=khong-co')).status).toBe(422);

    // User khác không thấy tiến trình của A
    const b = await createUser();
    expect(await (await b.client.get('/api/jobs')).json()).toEqual([]);
    expect((await b.client.get(`/api/jobs/${j1.id}`)).status).toBe(404);
    expect((await b.client.get(`/api/projects/${p1}/jobs`)).status).toBe(404);
  });

  it('đọc log theo con trỏ after và limit', async () => {
    const pid = await newProject(a);
    const job = await startJob(a, pid, (await uploadScript(a, pid, SCRIPT_4)).id);
    await runGenerateVoice(job.id, FAST);
    const first = await (await a.client.get(`/api/jobs/${job.id}/logs?limit=3`)).json();
    expect(first.items).toHaveLength(3);
    expect(first.status).toBe('completed');
    const rest = await (await a.client.get(`/api/jobs/${job.id}/logs?after=${first.items[2].id}&limit=500`)).json();
    expect(rest.items[0].id).toBeGreaterThan(first.items[2].id);
    const ids = [...first.items, ...rest.items].map((l: { id: number }) => l.id);
    expect(new Set(ids).size).toBe(ids.length); // không trùng
    expect(ids).toEqual([...ids].sort((x, y) => x - y)); // đúng thứ tự
    const b = await createUser();
    expect((await b.client.get(`/api/jobs/${job.id}/logs`)).status).toBe(404);
  });
});

describe('luồng SSE /api/jobs/{id}/events', () => {
  it('chưa đăng nhập → 401; User khác → 404', async () => {
    const pid = await newProject(a);
    const job = await startJob(a, pid, (await uploadScript(a, pid, SCRIPT_4)).id);
    expect((await new TestClient().get(`/api/jobs/${job.id}/events`)).status).toBe(401);
    const b = await createUser();
    expect((await b.client.get(`/api/jobs/${job.id}/events`)).status).toBe(404);
  });

  it('header đúng; nhận log, progress, status theo thứ tự rồi sự kiện end khi job kết thúc', async () => {
    await setScenario(admin, mock, 'delay-150');
    const pid = await newProject(a);
    const job = await startJob(a, pid, (await uploadScript(a, pid, SCRIPT_4)).id);

    const res = await a.client.get(`/api/jobs/${job.id}/events`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.headers.get('cache-control')).toContain('no-cache');
    expect(res.headers.get('x-accel-buffering')).toBe('no');

    const started = Date.now();
    const running = runGenerateVoice(job.id, { ...FAST, segmentConcurrency: 1 });
    const events = await readSse(res, (e) => e.some((x) => x.event === 'end'));
    await running;

    // log đầu tiên đến ngay (≤ 2 giây, SC-002) và là JOB_QUEUED
    const firstLog = events.find((e) => e.event === 'log')!;
    expect(firstLog.data.code).toBe('JOB_QUEUED');
    expect(Date.now() - started).toBeGreaterThan(0);

    const logIds = events.filter((e) => e.event === 'log').map((e) => e.id!);
    expect(logIds).toEqual([...logIds].sort((x, y) => x - y));
    expect(new Set(logIds).size).toBe(logIds.length);

    const codes = events.filter((e) => e.event === 'log').map((e) => e.data.code);
    for (const c of ['JOB_STARTED', 'PROVIDER_SELECTED', 'SEGMENT_DONE', 'VOICE_SAVED', 'JOB_COMPLETED']) expect(codes).toContain(c);

    const progress = events.filter((e) => e.event === 'progress').map((e) => e.data);
    expect(progress.length).toBeGreaterThan(1);
    expect(progress.at(-1)).toMatchObject({ status: 'completed', done: 4, total: 4, percent: 100 });
    const statuses = events.filter((e) => e.event === 'status').map((e) => e.data.status);
    expect(statuses).toContain('running');
    expect(statuses.at(-1)).toBe('completed');
    expect(events.filter((e) => e.event === 'status').at(-1)!.data.voiceId).toBeTruthy();
    expect(events.at(-1)).toMatchObject({ event: 'end', data: { status: 'completed' } });
  });

  it('nối lại bằng Last-Event-ID: không mất và không trùng log', async () => {
    await setScenario(admin, mock, 'delay-120');
    const pid = await newProject(a);
    const job = await startJob(a, pid, (await uploadScript(a, pid, SCRIPT_4)).id);
    const running = runGenerateVoice(job.id, { ...FAST, segmentConcurrency: 1 });

    // Kết nối 1: nhận vài log rồi ngắt (mô phỏng mất mạng)
    const res1 = await a.client.get(`/api/jobs/${job.id}/events`);
    const part1 = await readSse(res1, (e) => e.filter((x) => x.event === 'log').length >= 4);
    const logs1 = part1.filter((e) => e.event === 'log');
    expect(logs1.length).toBeGreaterThanOrEqual(4);
    const lastSeen = logs1.at(-1)!.id!;

    // Kết nối 2: gửi Last-Event-ID, nhận tiếp tới khi kết thúc
    const res2 = await a.client.get(`/api/jobs/${job.id}/events`, { headers: { 'last-event-id': String(lastSeen) } });
    const part2 = await readSse(res2, (e) => e.some((x) => x.event === 'end'));
    await running;
    const logs2 = part2.filter((e) => e.event === 'log');
    expect(logs2.every((e) => e.id! > lastSeen)).toBe(true);

    // Hợp hai phần = đúng toàn bộ log trong DB, mỗi dòng đúng một lần
    const dbIds = (await getDb().select({ id: jobLogs.id }).from(jobLogs).where(eq(jobLogs.jobId, job.id))).map((r) => r.id).sort((x, y) => x - y);
    const got = [...logs1, ...logs2].map((e) => e.id!).sort((x, y) => x - y);
    expect(got).toEqual(dbIds);
  });

  it('job đã kết thúc: phát lại toàn bộ log rồi end ngay', async () => {
    const pid = await newProject(a);
    const job = await startJob(a, pid, (await uploadScript(a, pid, SCRIPT_4)).id);
    await runGenerateVoice(job.id, FAST);
    const res = await a.client.get(`/api/jobs/${job.id}/events`);
    const events = await readSse(res, (e) => e.some((x) => x.event === 'end'), 10_000);
    expect(events.at(-1)!.event).toBe('end');
    const dbCount = (await getDb().select().from(jobLogs).where(eq(jobLogs.jobId, job.id))).length;
    expect(events.filter((e) => e.event === 'log')).toHaveLength(dbCount);
  });

  it('log thông báo lỗi nhà cung cấp hiển thị thân thiện, không lộ khóa', async () => {
    await setScenario(admin, mock, '401');
    const pid = await newProject(a);
    const job = await startJob(a, pid, (await uploadScript(a, pid, 'Một dòng.')).id);
    await runGenerateVoice(job.id, FAST);
    const res = await a.client.get(`/api/jobs/${job.id}/events`);
    const events = await readSse(res, (e) => e.some((x) => x.event === 'end'), 10_000);
    const failed = events.find((e) => e.event === 'log' && e.data.code === 'JOB_FAILED')!;
    expect(String(failed.data.message)).toContain('Khóa API không hợp lệ');
    expect(JSON.stringify(events)).not.toContain('sk-global-shared-key');
    expect(events.at(-1)).toMatchObject({ event: 'end', data: { status: 'failed' } });
  });
});
