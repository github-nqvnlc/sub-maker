import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { expectedDurationMs, startMockProvider, type MockProvider } from '../../mock-provider/server';
import { getDb } from '@/lib/db';
import { aiProviderConfigs } from '@/lib/db/schema';
import { runGenerateVoice } from '@/worker/jobs/generate-voice';
import { stopBoss } from '@/worker/queues';
import { clearRateLimits, createAdmin, createUser, resetDb, type TestUser } from './helpers';
import { FAST, jobRow, logCodes, newProject, postCount, putGlobalConfig, segmentRows, setScenario, startJob, uploadScript, usageRows, voiceOfJob } from './voice-helpers';

const fixture = (name: string) => fs.readFileSync(path.resolve(process.cwd(), 'tests/fixtures', name), 'utf8');
const TIMED = { timing: { mode: 'timed', mergeCues: true } };
const TIMED_SEPARATE = { timing: { mode: 'timed', mergeCues: false } };

let mock: MockProvider;
let admin: TestUser;
let user: TestUser;

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
  user = await createUser({ name: 'Người khớp mốc' });
});

async function prepare(fixtureName: string, over: Record<string, unknown> = TIMED) {
  const projectId = await newProject(user);
  const file = await uploadScript(user, projectId, fixture(fixtureName), fixtureName);
  const job = await startJob(user, projectId, file.id, over);
  return { projectId, file, job };
}

describe('voice khớp mốc phụ đề (spec 003, US1)', () => {
  it('đặt từng đơn vị đúng mốc bắt đầu của cue (±150 ms), voice dài bằng mốc cue cuối', async () => {
    const { job } = await prepare('sample-10s.srt');
    expect(job.status).toBe('queued');
    await runGenerateVoice(job.id, FAST);

    const j = await jobRow(job.id);
    expect(j).toMatchObject({ status: 'completed', progressDone: 3, progressTotal: 3, errorCode: null });
    expect(j.settings.timing).toMatchObject({ mode: 'timed', mergeCues: true, params: { maxSlipMs: 500, maxCompressPct: 125, mergeGapMs: 1000, partMinutes: 10 } });

    const voice = (await voiceOfJob(job.id))!;
    const starts = [300, 5005, 8772];
    expect(voice.timeline).toHaveLength(3);
    voice.timeline.forEach((t, i) => {
      expect(Math.abs(t.startMs - starts[i]!)).toBeLessThanOrEqual(150);
      expect(t.compress).toBe(1); // đủ chỗ: không nén
      expect(t.overflow).toBe(false);
      expect(t.cues).toHaveLength(1);
      expect(t.text).toBe(t.cues![0]!.text);
    });
    expect(voice.timeline[2]!.text).toBe('Không Putin.');
    expect(voice.timeline[2]!.endMs - voice.timeline[2]!.startMs).toBeCloseTo(expectedDurationMs('Không Putin.'), -1);
    expect(Math.abs(voice.durationMs - 9772)).toBeLessThanOrEqual(150);

    const codes = await logCodes(job.id);
    expect(codes).toEqual(expect.arrayContaining(['UNITS_BUILT', 'PLACEMENT_DONE', 'JOB_COMPLETED']));
  });

  it('API chi tiết voice trả text và mốc nội bộ từng cue; chi tiết job có timing', async () => {
    const { job } = await prepare('sample-10s.srt');
    await runGenerateVoice(job.id, FAST);
    const voice = (await voiceOfJob(job.id))!;
    const detail = await (await user.client.get(`/api/voices/${voice.id}`)).json();
    expect(detail.segments).toHaveLength(3);
    expect(detail.segments[0]).toMatchObject({ idx: 0, text: expect.stringContaining('Thẩm Quyến') });
    expect(detail.segments[0].cues[0]).toMatchObject({ n: 1, text: expect.any(String) });
    const jd = await (await user.client.get(`/api/jobs/${job.id}`)).json();
    expect(jd.timing).toMatchObject({ mode: 'timed', mergeCues: true, overflowCount: 0 });
    expect(jd.settings.timing).toEqual({ mode: 'timed', mergeCues: true });
  });

  it('chạy lại cùng cài đặt: 0 lần gọi nhà cung cấp, 0 usage mới', async () => {
    const first = await prepare('sample-10s.srt');
    await runGenerateVoice(first.job.id, FAST);
    expect(postCount(mock)).toBe(3);

    mock.reset();
    const second = await startJob(user, first.projectId, first.file.id, TIMED);
    await runGenerateVoice(second.id, FAST);
    expect((await jobRow(second.id)).status).toBe('completed');
    expect(postCount(mock)).toBe(0);
    expect(await usageRows(second.id)).toHaveLength(0);
  });

  it('tắt "Ghép cue cùng câu" chỉ gọi lại đơn vị có văn bản đổi (11 đơn vị, 2 đơn vị mới)', async () => {
    const first = await prepare('sample-synthetic.srt'); // 12 cue → 10 đơn vị (cue 1–2 ghép, cue ♪ im lặng)
    expect((await jobRow(first.job.id)).progressTotal).toBe(10);
    await runGenerateVoice(first.job.id, FAST);
    expect(postCount(mock)).toBe(10);

    mock.reset();
    const second = await startJob(user, first.projectId, first.file.id, TIMED_SEPARATE);
    expect((await jobRow(second.id)).progressTotal).toBe(11);
    await runGenerateVoice(second.id, FAST);
    expect((await jobRow(second.id)).status).toBe('completed');
    // chỉ "Xin chào các bạn," và "hôm nay trời đẹp." là văn bản mới
    expect(postCount(mock)).toBe(2);
  });

  it('đọc chậm (scenario ms-120): nén ≤ 1,25×, trượt nhẹ, không chồng tiếng, overflow ⇔ trượt > 500 ms', async () => {
    await setScenario(admin, mock, 'ms-120');
    const { job } = await prepare('sample-synthetic.srt');
    await runGenerateVoice(job.id, FAST);
    expect((await jobRow(job.id)).status).toBe('completed');

    const voice = (await voiceOfJob(job.id))!;
    const tl = voice.timeline;
    expect(tl.some((t) => (t.compress ?? 1) > 1)).toBe(true);
    for (let i = 0; i < tl.length; i++) {
      const t = tl[i]!;
      expect(t.compress).toBeLessThanOrEqual(1.25 + 1e-6);
      expect(t.slipMs).toBeGreaterThanOrEqual(0);
      expect(t.overflow).toBe((t.slipMs ?? 0) > 500);
      if (i > 0) expect(t.startMs).toBeGreaterThanOrEqual(tl[i - 1]!.endMs); // không chồng tiếng
    }
    expect(tl.some((t) => t.overflow)).toBe(true);
    expect(await logCodes(job.id)).toContain('UNIT_OVERFLOW');
    const jd = await (await user.client.get(`/api/jobs/${job.id}`)).json();
    expect(jd.timing.overflowCount).toBe(tl.filter((t) => t.overflow).length);
    expect(voice.durationMs).toBeGreaterThanOrEqual(tl[tl.length - 1]!.endMs);
  });

  it('khoảng lặng nhà cung cấp thêm vào (pad-200) được cắt: mốc vẫn khớp', async () => {
    await setScenario(admin, mock, 'pad-200');
    const { job } = await prepare('sample-10s.srt');
    await runGenerateVoice(job.id, FAST);
    const voice = (await voiceOfJob(job.id))!;
    [300, 5005, 8772].forEach((s, i) => expect(Math.abs(voice.timeline[i]!.startMs - s)).toBeLessThanOrEqual(150));
  });
});

describe('xử lý lỗi ở chế độ khớp mốc (FR-010)', () => {
  it('đoạn bị chặn nội dung → khe im lặng, job vẫn hoàn tất kèm danh sách đoạn lỗi', async () => {
    await setScenario(admin, mock, 'blocked-Putin');
    const { job } = await prepare('sample-10s.srt');
    await runGenerateVoice(job.id, FAST);

    const j = await jobRow(job.id);
    expect(j.status).toBe('completed');
    const voice = (await voiceOfJob(job.id))!;
    expect(voice.timeline[2]).toMatchObject({ idx: 2, failed: true, startMs: 8772, endMs: 9772, text: 'Không Putin.' });
    expect(voice.timeline[0]!.failed).toBeUndefined();
    const segs = await segmentRows(job.id);
    expect(segs.map((s) => s.status)).toEqual(['done', 'done', 'failed']);
    expect(segs[2]!.errorCode).toBe('CONTENT_BLOCKED');
    expect(await logCodes(job.id)).toContain('UNITS_FAILED');

    const jd = await (await user.client.get(`/api/jobs/${job.id}`)).json();
    expect(jd.failedSegments).toEqual([{ idx: 2, errorCode: 'CONTENT_BLOCKED' }]);
  });

  it('chế độ "Đọc liên tục" khi có đoạn bị chặn vẫn thất bại (không hồi quy spec 001)', async () => {
    await setScenario(admin, mock, 'blocked-Putin');
    const projectId = await newProject(user);
    const file = await uploadScript(user, projectId, 'Xin chào các bạn.\nKhông Putin ở đây.\nHết.', 'kich-ban.txt');
    const job = await startJob(user, projectId, file.id);
    await runGenerateVoice(job.id, FAST);
    expect(await jobRow(job.id)).toMatchObject({ status: 'failed', errorCode: 'CONTENT_BLOCKED' });
    expect(await voiceOfJob(job.id)).toBeNull();
  });

  it('lỗi khác (sai khóa) vẫn làm job thất bại, không tạo voice', async () => {
    await setScenario(admin, mock, '401');
    const { job } = await prepare('sample-10s.srt');
    await runGenerateVoice(job.id, FAST);
    expect((await jobRow(job.id)).status).toBe('failed');
    expect(await voiceOfJob(job.id)).toBeNull();
  });

  it('mọi đơn vị đều bị chặn → thất bại', async () => {
    await setScenario(admin, mock, 'blocked-.');
    const { job } = await prepare('sample-10s.srt'); // mọi văn bản đều kết thúc bằng dấu chấm
    await runGenerateVoice(job.id, FAST);
    expect(await jobRow(job.id)).toMatchObject({ status: 'failed', errorCode: 'CONTENT_BLOCKED' });
  });

  it('dừng giữa chừng rồi tiếp tục: không tạo lại đơn vị đã xong', async () => {
    await setScenario(admin, mock, 'ok-then-5xx-2');
    const { job } = await prepare('sample-10s.srt');
    await runGenerateVoice(job.id, FAST);
    expect((await jobRow(job.id)).status).toBe('failed');
    expect((await segmentRows(job.id)).map((s) => s.status)).toEqual(['done', 'done', 'failed']);

    await setScenario(admin, mock, 'ok');
    mock.reset();
    expect((await user.client.post(`/api/jobs/${job.id}/resume`, { json: {} })).status).toBeLessThan(300);
    await runGenerateVoice(job.id, FAST);
    expect((await jobRow(job.id)).status).toBe('completed');
    expect(postCount(mock)).toBe(1); // chỉ đơn vị cuối
    expect(await voiceOfJob(job.id)).not.toBeNull();
  });
});

describe('điều kiện và cô lập', () => {
  it('timing=timed với tệp không có mốc → 409 NO_TIMECODES', async () => {
    const projectId = await newProject(user);
    const file = await uploadScript(user, projectId, 'Chỉ là văn bản.', 'a.txt');
    const res = await user.client.post(`/api/projects/${projectId}/jobs`, { json: { fileId: file.id, ...TIMED } });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('NO_TIMECODES');
  });

  it('timing sai kiểu hoặc có trường lạ → 422', async () => {
    const projectId = await newProject(user);
    const file = await uploadScript(user, projectId, fixture('sample-10s.srt'), 'a.srt');
    for (const timing of [{ mode: 'fast' }, { mode: 'timed', extra: 1 }, 'timed']) {
      const res = await user.client.post(`/api/projects/${projectId}/jobs`, { json: { fileId: file.id, timing } });
      expect(res.status, JSON.stringify(timing)).toBe(422);
    }
  });

  it('cache không dùng chung giữa hai người dùng: người thứ hai phải gọi lại', async () => {
    const first = await prepare('sample-10s.srt');
    await runGenerateVoice(first.job.id, FAST);
    expect(postCount(mock)).toBe(3);

    const other = await createUser({ name: 'Người khác' });
    const projectId = await newProject(other);
    const file = await uploadScript(other, projectId, fixture('sample-10s.srt'), 'a.srt');
    const job = await startJob(other, projectId, file.id, TIMED);
    await runGenerateVoice(job.id, FAST);
    expect(postCount(mock)).toBe(6);
  });

  it('hạn mức: dung lượng ước tính vượt hạn mức → 409 QUOTA_EXCEEDED kèm needBytes, không tạo job', async () => {
    const projectId = await newProject(user);
    const file = await uploadScript(user, projectId, fixture('sample-10s.srt'), 'a.srt');
    const { getDb: db } = await import('@/lib/db');
    const { users } = await import('@/lib/db/schema');
    const { eq } = await import('drizzle-orm');
    await db().update(users).set({ storageUsedBytes: 524_288_000 - 1000 }).where(eq(users.id, user.id));
    const res = await user.client.post(`/api/projects/${projectId}/jobs`, { json: { fileId: file.id, ...TIMED } });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('QUOTA_EXCEEDED');
    expect(Number(body.error.fields.needBytes)).toBeGreaterThan(0);
  });
});
