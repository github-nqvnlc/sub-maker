import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startMockProvider, type MockProvider } from '../../mock-provider/server';
import { getDb } from '@/lib/db';
import { overlayJobs, systemSettings } from '@/lib/db/schema';
import { updateSettings } from '@/lib/settings';
import { runGenerateVoice } from '@/worker/jobs/generate-voice';
import { OVERLAY_LOCAL_CONCURRENCY, runRenderOverlay } from '@/worker/jobs/render-overlay';
import { stopBoss } from '@/worker/queues';
import { clearRateLimits, createAdmin, createUser, resetDb, type TestUser } from './helpers';
import { FAST_RENDER, fakeRender } from './overlay-fake-render';
import { createOverlayJob, makeVoice, overlayLogKeys, overlayRow, uploadSrt } from './overlay-helpers';
import { FAST, jobRow, newProject, putGlobalConfig, startJob, uploadScript } from './voice-helpers';

/** Giới hạn đồng thời riêng của tiến trình xuất video (spec 005, FR-041, SC-011, T035). */
let mock: MockProvider;
let admin: TestUser;
let user: TestUser;
let projectId: string;
let fileId: string;
let voiceId: string;

beforeAll(async () => {
  mock = await startMockProvider();
  await resetDb();
  admin = await createAdmin();
  await putGlobalConfig(admin, mock);
}, 60_000);
afterAll(async () => {
  await mock.close();
  await stopBoss();
});
beforeEach(async () => {
  await clearRateLimits();
  await getDb().delete(systemSettings);
  await getDb().delete(overlayJobs);
  user = await createUser();
  projectId = await newProject(user);
  fileId = await uploadSrt(user, projectId);
  voiceId = (await makeVoice(user, projectId, fileId)).voiceId;
});

const newJob = () => createOverlayJob(user, projectId, { fileId, voiceId });
const until = async (fn: () => Promise<boolean>) => {
  for (let k = 0; k < 200; k++) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('quá thời gian chờ');
};
const status = async (id: string) => (await overlayRow(id))!.status;

describe('giới hạn toàn hệ thống', () => {
  it('mặc định 1 tiến trình chạy; phần dư chờ và ghi lý do; xong thì tới lượt', async () => {
    const [a, b] = [await newJob(), await newJob()];
    const fa = fakeRender({ hold: true });
    const fb = fakeRender();
    const ra = runRenderOverlay(a.id, { ...FAST_RENDER, spawnRender: fa.spawn });
    await fa.started;
    const rb = runRenderOverlay(b.id, { ...FAST_RENDER, spawnRender: fb.spawn });
    await until(async () => (await overlayLogKeys(b.id)).includes('waiting'));
    expect([await status(a.id), await status(b.id)]).toEqual(['running', 'queued']);
    fa.release();
    await Promise.all([ra, rb]);
    expect([await status(a.id), await status(b.id)]).toEqual(['completed', 'completed']);
  });

  it('việc tạo trước chạy trước khi cùng chờ', async () => {
    await updateSettings({ maxOverlayJobsPerUser: 5 }, null);
    const [a, b, c] = [await newJob(), await newJob(), await newJob()];
    const order: string[] = [];
    const fa = fakeRender({ hold: true });
    const ra = runRenderOverlay(a.id, { ...FAST_RENDER, spawnRender: fa.spawn });
    await fa.started;
    const track = (id: string) => {
      const f = fakeRender();
      return runRenderOverlay(id, {
        ...FAST_RENDER,
        spawnRender: (...args) => {
          order.push(id);
          return f.spawn(...args);
        },
      });
    };
    // c bắt đầu chờ trước b nhưng b được tạo trước
    const rc = track(c.id);
    await until(async () => (await overlayLogKeys(c.id)).includes('waiting'));
    const rb = track(b.id);
    await until(async () => (await overlayLogKeys(b.id)).includes('waiting'));
    fa.release();
    await Promise.all([ra, rb, rc]);
    expect(order).toEqual([b.id, c.id]);
  });

  it('Administrator tăng giới hạn: chạy song song ngay', async () => {
    await updateSettings({ maxConcurrentOverlayJobs: 2 }, null);
    const [a, b] = [await newJob(), await newJob()];
    const [fa, fb] = [fakeRender({ hold: true }), fakeRender({ hold: true })];
    const ra = runRenderOverlay(a.id, { ...FAST_RENDER, spawnRender: fa.spawn });
    const rb = runRenderOverlay(b.id, { ...FAST_RENDER, spawnRender: fb.spawn });
    await Promise.all([fa.started, fb.started]);
    expect([await status(a.id), await status(b.id)]).toEqual(['running', 'running']);
    fa.release();
    fb.release();
    await Promise.all([ra, rb]);
    expect(OVERLAY_LOCAL_CONCURRENCY).toBeGreaterThanOrEqual(10);
  });

  it('cùng một job được hai worker nhận: chỉ một bên chạy', async () => {
    const job = await newJob();
    const [f1, f2] = [fakeRender(), fakeRender()];
    await Promise.all([runRenderOverlay(job.id, { ...FAST_RENDER, spawnRender: f1.spawn }), runRenderOverlay(job.id, { ...FAST_RENDER, spawnRender: f2.spawn })]);
    expect(f1.calls + f2.calls).toBe(1);
  });
});

describe('không chiếm chỗ của tiến trình voice (FR-041)', () => {
  it('đang xuất video, voice mới bắt đầu và hoàn tất bình thường dù giới hạn voice là 1', async () => {
    await updateSettings({ maxConcurrentJobs: 1, maxJobsPerUser: 1 }, null);
    const job = await newJob();
    const fake = fakeRender({ hold: true });
    const running = runRenderOverlay(job.id, { ...FAST_RENDER, spawnRender: fake.spawn });
    await fake.started;
    const script = await uploadScript(user, projectId, 'Xin chào các bạn.\nHẹn gặp lại.');
    const vj = await startJob(user, projectId, script.id);
    const t0 = Date.now();
    await runGenerateVoice(vj.id, FAST);
    expect((await jobRow(vj.id)).status).toBe('completed');
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(await status(job.id)).toBe('running');
    fake.release();
    await running;
    expect((await getDb().select().from(overlayJobs).where(eq(overlayJobs.id, job.id)))[0]!.status).toBe('completed');
  });
});
