import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { expectedDurationMs, startMockProvider, type MockProvider } from '../../mock-provider/server';
import { getDb } from '@/lib/db';
import { aiProviderConfigs, audioCache, projects, usageRecords, users, voiceJobs, voices } from '@/lib/db/schema';
import { headObject } from '@/lib/storage/client';
import { runGenerateVoice } from '@/worker/jobs/generate-voice';
import { stopBoss } from '@/worker/queues';
import { clearRateLimits, createAdmin, createUser, resetDb, type TestUser } from './helpers';
import { FAST, GLOBAL_KEY, SCRIPT_4, jobRow, logCodes, logRows, newProject, postCount, putGlobalConfig, segmentRows, setScenario, startJob, uploadScript, usageRows, voiceOfJob } from './voice-helpers';

let mock: MockProvider;
let admin: TestUser;
let user: TestUser;

const LINES = SCRIPT_4.split('\n');

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
  await putGlobalConfig(admin, mock, 'ok', { pricePerMillionChars: 1_000_000 });
  user = await createUser({ name: 'Người tạo voice' });
});

async function prepare(text = SCRIPT_4, startOver: Record<string, unknown> = {}) {
  const projectId = await newProject(user);
  const file = await uploadScript(user, projectId, text);
  const job = await startJob(user, projectId, file.id, startOver);
  return { projectId, file, job };
}

describe('tạo voice thành công', () => {
  it('chạy hết các đoạn, ghép voice có timeline chính xác, ghi usage/log/dung lượng đúng', async () => {
    const { projectId, file, job } = await prepare();
    expect(job.status).toBe('queued');
    expect(file.segmentCount).toBe(4);

    await runGenerateVoice(job.id, FAST);

    const j = await jobRow(job.id);
    expect(j).toMatchObject({ status: 'completed', progressDone: 4, progressTotal: 4, errorCode: null, configScope: 'global' });
    expect(j.finishedAt).toBeTruthy();

    const voice = await voiceOfJob(job.id);
    expect(voice).not.toBeNull();
    const timeline = voice!.timeline;
    expect(timeline).toHaveLength(4);

    // Mốc thời gian đúng theo số mẫu: đoạn i dài expectedDurationMs, giữa các đoạn là 380 ms (đều kết thúc bằng dấu chấm)
    let cursor = 0;
    LINES.forEach((line, i) => {
      const d = expectedDurationMs(line);
      expect(timeline[i]).toEqual({ idx: i, startMs: cursor, endMs: cursor + d });
      cursor += d + (i < LINES.length - 1 ? 380 : 0);
    });
    expect(voice!.durationMs).toBe(cursor);
    expect(voice!.format).toBe('mp3');

    // File mp3 có thật trên MinIO, kích thước khớp
    expect(await headObject(voice!.storageKey)).toMatchObject({ size: voice!.sizeBytes });

    // Project cập nhật
    const [p] = await getDb().select().from(projects).where(eq(projects.id, projectId));
    expect(p!.voiceCount).toBe(1);

    // Usage: mỗi đoạn một lần gọi thật, ghi đúng ký tự, nguồn cấu hình, chi phí ước tính theo giá cấu hình
    const usage = await usageRows(job.id);
    expect(usage).toHaveLength(4);
    expect(usage.every((u) => u.ok && u.configScope === 'global' && u.userId === user.id && u.projectId === projectId)).toBe(true);
    // các đoạn chạy song song nên thứ tự ghi usage không cố định: so sánh theo tập (đã sắp xếp)
    const sortNum = (xs: Array<number | null>) => [...xs].sort((a, b) => (a ?? 0) - (b ?? 0));
    expect(sortNum(usage.map((u) => u.unitsChars))).toEqual(sortNum(LINES.map((l) => [...l].length)));
    expect(usage.every((u) => u.unitsTokens === null)).toBe(true); // không bịa token
    expect(sortNum(usage.map((u) => u.costEstimateUsd))).toEqual(sortNum(LINES.map((l) => [...l].length))); // giá 1.000.000/1 triệu ký tự = 1 USD/ký tự

    // Log theo đúng trình tự sự kiện
    const codes = await logCodes(job.id);
    expect(codes[0]).toBe('JOB_QUEUED');
    for (const c of ['JOB_STARTED', 'PROVIDER_SELECTED', 'FILE_PARSED', 'MERGING', 'ENCODING', 'VOICE_SAVED', 'JOB_COMPLETED']) expect(codes).toContain(c);
    expect(codes.filter((c) => c === 'SEGMENT_DONE')).toHaveLength(4);
    expect(codes.indexOf('MERGING')).toBeGreaterThan(codes.lastIndexOf('SEGMENT_DONE'));

    // Dung lượng: file gốc + cache từng đoạn + mp3 (tính chính xác, không lệch)
    const cache = await getDb().select().from(audioCache).where(eq(audioCache.ownerId, user.id));
    const [u] = await getDb().select().from(users).where(eq(users.id, user.id));
    const fileBytes = new TextEncoder().encode(SCRIPT_4).length;
    expect(u!.storageUsedBytes).toBe(fileBytes + cache.reduce((s, c) => s + c.sizeBytes, 0) + voice!.sizeBytes);
  });

  it('mọi dòng log và bản ghi KHÔNG chứa khóa API', async () => {
    const { job } = await prepare();
    await runGenerateVoice(job.id, FAST);
    const everything = JSON.stringify([await logRows(job.id), await usageRows(job.id), await jobRow(job.id), await segmentRows(job.id)]);
    expect(everything).not.toContain(GLOBAL_KEY);
    expect(everything).not.toContain('Bearer');
    // yêu cầu gửi đi vẫn dùng đúng khóa
    expect(mock.requests.find((r) => r.method === 'POST')!.headers['authorization']).toBe(`Bearer ${GLOBAL_KEY}`);
  });

  it('log PROVIDER_SELECTED nêu chung/riêng nhưng không lộ khóa hay địa chỉ có khóa', async () => {
    const { job } = await prepare();
    await runGenerateVoice(job.id, FAST);
    const sel = (await logRows(job.id)).find((l) => l.code === 'PROVIDER_SELECTED')!;
    expect(sel.message).toContain('chung');
    expect(sel.message).not.toMatch(/sk-|key=|Bearer/);
  });
});

describe('cache (FR-017, SC-008)', () => {
  it('chạy lại cùng kịch bản và thiết lập: mọi đoạn dùng cache, KHÔNG gọi nhà cung cấp, không thêm usage', async () => {
    const { projectId, file, job } = await prepare();
    await runGenerateVoice(job.id, FAST);
    const usageBefore = (await getDb().select().from(usageRecords)).length;
    mock.reset();

    const job2 = await startJob(user, projectId, file.id);
    await runGenerateVoice(job2.id, FAST);

    expect((await jobRow(job2.id)).status).toBe('completed');
    expect(postCount(mock)).toBe(0);
    expect(await usageRows(job2.id)).toHaveLength(0);
    const usageAfter = (await getDb().select().from(usageRecords)).length;
    expect(usageAfter).toBe(usageBefore);
    const codes = await logCodes(job2.id);
    expect(codes.filter((c) => c === 'SEGMENT_CACHE_HIT')).toHaveLength(4);
    expect((await segmentRows(job2.id)).every((s) => s.cacheHit && s.status === 'done')).toBe(true);
    // vẫn ra một voice mới có timeline
    expect((await voiceOfJob(job2.id))!.timeline).toHaveLength(4);
  });

  it('đổi giọng thì KHÔNG dùng cache (gọi lại nhà cung cấp)', async () => {
    const { projectId, file, job } = await prepare();
    await runGenerateVoice(job.id, FAST);
    mock.reset();
    const job2 = await startJob(user, projectId, file.id, { voice: 'thuminh' });
    await runGenerateVoice(job2.id, FAST);
    expect(postCount(mock)).toBe(4);
    expect((await usageRows(job2.id)).every((u) => u.voice === 'thuminh')).toBe(true);
  });

  it('cache theo User: User khác với cùng nội dung vẫn phải gọi nhà cung cấp (không rò rỉ giữa User)', async () => {
    const { job } = await prepare();
    await runGenerateVoice(job.id, FAST);
    mock.reset();

    const other = await createUser({ name: 'Người thứ hai' });
    const pid = await newProject(other);
    const file = await uploadScript(other, pid, SCRIPT_4);
    const j2 = await startJob(other, pid, file.id);
    await runGenerateVoice(j2.id, FAST);
    expect(postCount(mock)).toBe(4);
    expect(await logCodes(j2.id)).not.toContain('SEGMENT_CACHE_HIT');
  });
});

describe('lỗi tạm thời: thử lại có giới hạn', () => {
  it('429 rồi thành công: ghi RETRY, usage lỗi (ok=false) + usage thành công (ok=true)', async () => {
    await setScenario(admin, mock, '429-then-ok');
    const { job } = await prepare('Một câu duy nhất để thử lại.');
    await runGenerateVoice(job.id, FAST);
    expect((await jobRow(job.id)).status).toBe('completed');
    expect(await logCodes(job.id)).toContain('RETRY');
    const usage = await usageRows(job.id);
    expect(usage.map((u) => u.ok)).toEqual([false, true]);
    expect(usage[0]!.costEstimateUsd).toBeNull(); // lần lỗi không tính phí
    expect(postCount(mock)).toBe(2);
  });

  it('5xx liên tục: hết số lần thử thì job failed (TRANSIENT), đúng số lần gọi, đoạn failed', async () => {
    await setScenario(admin, mock, '5xx');
    const { job } = await prepare('Một câu duy nhất.');
    await runGenerateVoice(job.id, { ...FAST, retry: { maxAttempts: 3, baseMs: 5, maxMs: 10 }, segmentConcurrency: 1 });
    const j = await jobRow(job.id);
    expect(j).toMatchObject({ status: 'failed', errorCode: 'TRANSIENT' });
    expect(j.errorMessage).toContain('tiếp tục');
    expect(postCount(mock)).toBe(3);
    expect((await segmentRows(job.id))[0]).toMatchObject({ status: 'failed', errorCode: 'TRANSIENT', attempts: 3 });
    expect(await voiceOfJob(job.id)).toBeNull();
  });
});

describe('lỗi vĩnh viễn: KHÔNG thử lại', () => {
  it.each([
    ['401', 'AUTH'],
    ['403-quota', 'QUOTA'],
    ['400-voice', 'VOICE_INVALID'],
  ])('%s → job failed %s ngay, chỉ 1 lần gọi', async (scenario, code) => {
    await setScenario(admin, mock, scenario);
    const { job } = await prepare();
    await runGenerateVoice(job.id, { ...FAST, segmentConcurrency: 1 });
    const j = await jobRow(job.id);
    expect(j).toMatchObject({ status: 'failed', errorCode: code });
    expect(postCount(mock)).toBe(1);
    const codes = await logCodes(job.id);
    expect(codes).not.toContain('RETRY');
    expect(codes).toContain('JOB_FAILED');
  });

  it('nội dung bị chặn: các đoạn khác vẫn chạy xong, job failed CONTENT_BLOCKED kèm danh sách đoạn lỗi', async () => {
    await setScenario(admin, mock, 'policy-marker');
    const text = ['Đoạn đầu bình thường.', 'Đoạn này có [BLOCK] bị chặn.', 'Đoạn cuối cũng bình thường.'].join('\n');
    const { projectId, job } = await prepare(text);
    await runGenerateVoice(job.id, { ...FAST, segmentConcurrency: 1 });

    const j = await jobRow(job.id);
    expect(j).toMatchObject({ status: 'failed', errorCode: 'CONTENT_BLOCKED' });
    expect(j.errorMessage).toContain('đoạn 2');
    const segs = await segmentRows(job.id);
    expect(segs.map((s) => s.status)).toEqual(['done', 'failed', 'done']);
    expect(segs[1]!.errorCode).toBe('CONTENT_BLOCKED');
    expect(postCount(mock)).toBe(3); // không thử lại đoạn bị chặn
    expect(await voiceOfJob(job.id)).toBeNull();

    // API chi tiết trả danh sách đoạn lỗi
    const detail = await (await user.client.get(`/api/jobs/${job.id}`)).json();
    expect(detail.failedSegments).toEqual([{ idx: 1, errorCode: 'CONTENT_BLOCKED' }]);
    expect(projectId).toBeTruthy();
  });

  it('cấu hình chung bị xóa trước khi worker nhận job → failed PROVIDER_NOT_CONFIGURED', async () => {
    const { job } = await prepare();
    await getDb().delete(aiProviderConfigs);
    await runGenerateVoice(job.id, FAST);
    expect(await jobRow(job.id)).toMatchObject({ status: 'failed', errorCode: 'PROVIDER_NOT_CONFIGURED' });
    expect(postCount(mock)).toBe(0);
  });
});

describe('tiếp tục từ chỗ dở (Nguyên tắc III)', () => {
  it('sự cố giữa chừng rồi tiếp tục: các đoạn đã xong KHÔNG bị gọi lại, hoàn tất đúng, usage không lặp', async () => {
    await setScenario(admin, mock, 'ok-then-5xx-2'); // 2 đoạn đầu thành công, sau đó 503
    const { job } = await prepare();
    await runGenerateVoice(job.id, { ...FAST, retry: { maxAttempts: 2, baseMs: 5, maxMs: 10 }, segmentConcurrency: 1 });

    let j = await jobRow(job.id);
    expect(j).toMatchObject({ status: 'failed', errorCode: 'TRANSIENT', progressDone: 2 });
    expect((await segmentRows(job.id)).map((s) => s.status)).toEqual(['done', 'done', 'failed', 'pending']);

    // Nhà cung cấp hồi phục; "tiếp tục" = đưa job về hàng đợi và chạy lại cùng job
    mock.reset();
    await getDb().update(voiceJobs).set({ status: 'queued' }).where(eq(voiceJobs.id, job.id));
    await runGenerateVoice(job.id, { ...FAST, segmentConcurrency: 1 });

    j = await jobRow(job.id);
    expect(j).toMatchObject({ status: 'completed', progressDone: 4, errorCode: null });
    expect(postCount(mock)).toBe(2); // chỉ gọi 2 đoạn còn lại
    const codes = await logCodes(job.id);
    expect(codes).toContain('JOB_RESUMED');
    expect(codes).toContain('SEGMENTS_SKIPPED');
    expect((await usageRows(job.id)).filter((u) => u.ok)).toHaveLength(4); // đúng 4 lần gọi thành công, không lặp
    expect((await voiceOfJob(job.id))!.timeline).toHaveLength(4);
  });

  it('audio cache của đoạn đã xong bị mất → làm lại đúng đoạn đó khi tiếp tục', async () => {
    const { job } = await prepare();
    await runGenerateVoice(job.id, FAST);
    // giả lập hỏng: xóa một mục cache và đưa job về hàng đợi (voice cũ xóa để chạy lại được)
    const segs = await segmentRows(job.id);
    await getDb().delete(audioCache).where(eq(audioCache.id, segs[2]!.audioCacheId!));
    await getDb().update(voiceJobs).set({ status: 'queued' }).where(eq(voiceJobs.id, job.id));
    await getDb().delete(voices).where(eq(voices.jobId, job.id));
    mock.reset();
    await runGenerateVoice(job.id, FAST);
    expect((await jobRow(job.id)).status).toBe('completed');
    expect(postCount(mock)).toBe(1);
  });

  it('job đã completed/failed/running KHÔNG bị nhận lại (không chạy hai lần)', async () => {
    const { job } = await prepare();
    await runGenerateVoice(job.id, FAST);
    mock.reset();
    await runGenerateVoice(job.id, FAST); // đã completed
    expect(postCount(mock)).toBe(0);
    expect((await getDb().select().from(voices)).filter((v) => v.jobId === job.id)).toHaveLength(1);
  });
});

describe('dừng giữa chừng', () => {
  it('yêu cầu dừng: job stopped, giữ phần đã xong; tiếp tục thì hoàn tất', async () => {
    await setScenario(admin, mock, 'delay-250');
    const { job } = await prepare();
    const running = runGenerateVoice(job.id, { ...FAST, heartbeatMs: 50, segmentConcurrency: 1 });
    // đợi đoạn đầu xong rồi đặt cờ dừng
    for (let i = 0; i < 100; i++) {
      await new Promise((r) => setTimeout(r, 30));
      if ((await jobRow(job.id)).progressDone >= 1) break;
    }
    await getDb().update(voiceJobs).set({ cancelRequested: true }).where(eq(voiceJobs.id, job.id));
    await running;

    const stopped = await jobRow(job.id);
    expect(stopped.status).toBe('stopped');
    expect(stopped.progressDone).toBeGreaterThanOrEqual(1);
    expect(stopped.progressDone).toBeLessThan(4);
    expect(await logCodes(job.id)).toContain('JOB_STOPPED');
    expect(await voiceOfJob(job.id)).toBeNull();
    const doneBefore = (await segmentRows(job.id)).filter((s) => s.status === 'done').length;

    // Tiếp tục
    mock.reset();
    await setScenario(admin, mock, 'ok');
    await getDb().update(voiceJobs).set({ status: 'queued', cancelRequested: false }).where(eq(voiceJobs.id, job.id));
    await runGenerateVoice(job.id, FAST);
    expect((await jobRow(job.id)).status).toBe('completed');
    expect(postCount(mock)).toBe(4 - doneBefore);
  });

  it('job có cờ dừng khi còn xếp hàng thì không bao giờ được nhận', async () => {
    const { job } = await prepare();
    await getDb().update(voiceJobs).set({ cancelRequested: true }).where(eq(voiceJobs.id, job.id));
    await runGenerateVoice(job.id, FAST);
    expect((await jobRow(job.id)).status).toBe('queued');
    expect(postCount(mock)).toBe(0);
  });
});

describe('chọn cấu hình lúc bắt đầu', () => {
  it('User trong danh sách có cấu hình riêng: dùng khóa riêng, usage ghi scope user; gỡ khỏi danh sách thì quay về cấu hình chung', async () => {
    await admin.client.post('/api/admin/custom-ai-users', { json: { userId: user.id } });
    const PRIVATE = 'sk-user-private-key-QQQQ1234';
    const put = await user.client.put('/api/me/ai-config', {
      json: { type: 'fpt_marketplace', baseUrl: `${mock.url}/s/ok/v1`, apiKey: PRIVATE, defaultModel: 'FPT.AI-VITs', defaultVoice: 'banmai' },
    });
    expect(put.status).toBe(200);

    const { projectId, file, job } = await prepare(LINES[0]);
    await runGenerateVoice(job.id, FAST);
    expect((await jobRow(job.id)).configScope).toBe('user');
    expect((await usageRows(job.id)).every((u) => u.configScope === 'user')).toBe(true);
    expect(mock.requests.find((r) => r.method === 'POST')!.headers['authorization']).toBe(`Bearer ${PRIVATE}`);
    expect(await (async () => (await logRows(job.id)).find((l) => l.code === 'PROVIDER_SELECTED')!.message)()).toContain('RIÊNG');
    expect(JSON.stringify(await logRows(job.id))).not.toContain(PRIVATE);

    // Gỡ khỏi danh sách → job mới (khác nội dung để không dùng cache) dùng cấu hình chung
    await admin.client.delete(`/api/admin/custom-ai-users/${user.id}`);
    mock.reset();
    const file2 = await uploadScript(user, projectId, 'Một nội dung hoàn toàn khác biệt.');
    const job2 = await startJob(user, projectId, file2.id);
    await runGenerateVoice(job2.id, FAST);
    expect((await jobRow(job2.id)).configScope).toBe('global');
    expect(mock.requests.find((r) => r.method === 'POST')!.headers['authorization']).toBe(`Bearer ${GLOBAL_KEY}`);
    expect(file.id).toBeTruthy();
  });
});
