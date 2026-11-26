import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '@/lib/db';
import { users, videoCues } from '@/lib/db/schema';
import type { CueListDto } from '@/lib/video/cues';
import { cueBytes, type Cue, type VideoMedia } from '@/lib/video/types';
import { stopBoss } from '@/worker/queues';
import { clearRateLimits, createAdmin, createUser, resetDb, type TestUser } from './helpers';
import { errorOf, insertVideoJob, videoJobRow, type VideoJobInsert } from './video-helpers';
import { cuesOf } from './video-pipeline-helpers';
import { newProject } from './voice-helpers';

/** Đọc và sửa cue qua API (spec 006, T056; FR-023, FR-024, FR-055; contracts/subtitle-pipeline.md §3). */
let user: TestUser;
let other: TestUser;
let projectId: string;

const MEDIA: VideoMedia = {
  durationMs: 3_600_000,
  width: 1920,
  height: 1080,
  fps: 25,
  videoCodec: 'h264',
  videoBitrate: 4_000_000,
  audioCodec: 'aac',
  audioIndex: 1,
  audioStartMs: 0,
  audioDurationMs: 3_600_000,
  audioStreams: 1,
  rotation: 0,
  hdr: false,
  matrix: 'bt709',
  browserPlayable: true,
};

beforeAll(async () => {
  await resetDb();
  await createAdmin();
}, 60_000);
afterAll(async () => {
  await stopBoss();
});
beforeEach(async () => {
  await clearRateLimits();
  user = await createUser(); // KHÔNG có quyền Dịch Video: sửa dữ liệu đã có không cần quyền
  other = await createUser();
  projectId = await newProject(user);
});

const makeCues = (count: number): Cue[] =>
  Array.from({ length: count }, (_, i) => ({
    id: crypto.randomUUID(),
    startMs: i * 1000,
    endMs: i * 1000 + 800,
    timing: 'measured' as const,
    sourceText: `Sentence number ${i}.`,
    targetText: `Câu số ${i}.`,
    sourceLang: 'en',
    speaker: '1',
    flags: {},
  }));

const bytesOf = (cues: readonly Cue[]) => cues.reduce((n, c) => n + cueBytes(c), 0);

async function readyJob(cues = makeCues(3), over: VideoJobInsert = {}) {
  const job = await insertVideoJob(user.id, projectId, {
    status: 'review_ready',
    sourceState: 'ready',
    media: MEDIA,
    cueRun: 1,
    cueRevision: 1,
    cueCount: cues.length,
    scriptBytes: bytesOf(cues),
    lastActivityAt: new Date(Date.now() - 3 * 24 * 3600_000),
    ...over,
  });
  for (let i = 0; i < cues.length; i += 1000) {
    await getDb()
      .insert(videoCues)
      .values(cues.slice(i, i + 1000).map((c) => ({ ...c, jobId: job.id })));
  }
  await getDb()
    .update(users)
    .set({ storageUsedBytes: sql`${users.storageUsedBytes} + ${bytesOf(cues)}` })
    .where(eq(users.id, user.id));
  return { job, cues };
}

const storageUsed = async () => (await getDb().select({ n: users.storageUsedBytes }).from(users).where(eq(users.id, user.id)))[0]!.n;
const getList = (jobId: string, who = user) => who.client.get(`/api/video/jobs/${jobId}/cues`);
const postOps = (jobId: string, json: unknown, who = user) => who.client.post(`/api/video/jobs/${jobId}/cues/ops`, { json });

describe('đọc kịch bản', () => {
  it('trả số phiên bản và cue theo thứ tự mốc; không lộ cột nội bộ', async () => {
    const { job, cues } = await readyJob();
    const res = await getList(job.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as CueListDto;
    expect(body.revision).toBe(1);
    expect(body.cues).toEqual(cues);
  });

  it('việc của người khác, id sai → 404, cả đọc lẫn ghi', async () => {
    const { job, cues } = await readyJob();
    expect((await getList(job.id, other)).status).toBe(404);
    const res = await postOps(job.id, { baseRevision: 1, ops: [{ type: 'delete', id: cues[0]!.id }] }, other);
    expect(res.status).toBe(404);
    expect((await getList('khong-phai-uuid')).status).toBe(404);
    expect(await cuesOf(job.id)).toHaveLength(3);
  });
});

describe('lưu lô thao tác', () => {
  it('ghi thay đổi, tăng phiên bản, cập nhật số cue, dung lượng chữ, hạn mức, lần hoạt động và hạn giữ video', async () => {
    const { job, cues } = await readyJob();
    const before = await storageUsed();
    const added: Cue = { id: crypto.randomUUID(), startMs: 10_000, endMs: 11_000, timing: 'manual', sourceText: '', targetText: 'Đoạn mới', sourceLang: null, speaker: null, flags: {} };
    const res = await postOps(job.id, {
      baseRevision: 1,
      ops: [
        { type: 'update', id: cues[0]!.id, patch: { targetText: 'Một câu dịch đã được sửa dài hơn hẳn.', endMs: 900 } },
        { type: 'delete', id: cues[1]!.id },
        { type: 'insert', cue: added },
      ],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revision: 2 });

    const saved = ((await (await getList(job.id)).json()) as CueListDto).cues;
    expect(saved.map((c) => c.id)).toEqual([cues[0]!.id, cues[2]!.id, added.id]);
    expect(saved[0]).toMatchObject({ targetText: 'Một câu dịch đã được sửa dài hơn hẳn.', endMs: 900, timing: 'manual', flags: { fast: true } });
    expect(saved[2]).toEqual(added);
    const row = (await videoJobRow(job.id))!;
    expect(row).toMatchObject({ cueRevision: 2, cueCount: 3, scriptBytes: bytesOf(saved) });
    expect(await storageUsed()).toBe(before + bytesOf(saved) - bytesOf(cues));
    expect(row.lastActivityAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
    // chưa xuất lần nào: hạn giữ = lần hoạt động gần nhất + 7 ngày
    expect(Math.abs(row.sourceExpiresAt!.getTime() - row.lastActivityAt.getTime() - 7 * 24 * 3600_000)).toBeLessThan(1000);
  });

  it('phiên bản cũ → CUE_CONFLICT kèm phiên bản hiện tại, không ghi gì', async () => {
    const { job, cues } = await readyJob();
    expect((await postOps(job.id, { baseRevision: 1, ops: [{ type: 'update', id: cues[0]!.id, patch: { targetText: 'tab một' } }] })).status).toBe(200);
    const res = await postOps(job.id, { baseRevision: 1, ops: [{ type: 'update', id: cues[0]!.id, patch: { targetText: 'tab hai' } }] });
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toMatchObject({ code: 'CUE_CONFLICT', fields: { revision: '2' } });
    expect((await cuesOf(job.id))[0]!.targetText).toBe('tab một');
  });

  it('hai yêu cầu cùng lúc trên cùng phiên bản: đúng một yêu cầu được ghi', async () => {
    const { job, cues } = await readyJob();
    const send = (t: string) => postOps(job.id, { baseRevision: 1, ops: [{ type: 'update', id: cues[0]!.id, patch: { targetText: t } }] });
    const statuses = (await Promise.all([send('A'), send('B'), send('C')])).map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409, 409]);
    expect((await videoJobRow(job.id))!.cueRevision).toBe(2);
  });

  it('một thao tác sai → CUE_INVALID nêu cue và lý do, cả lô không được ghi', async () => {
    const { job, cues } = await readyJob();
    const res = await postOps(job.id, {
      baseRevision: 1,
      ops: [
        { type: 'update', id: cues[0]!.id, patch: { targetText: 'hợp lệ' } },
        { type: 'update', id: cues[1]!.id, patch: { startMs: 100 } },
      ],
    });
    expect(res.status).toBe(422);
    expect(await errorOf(res)).toMatchObject({ code: 'CUE_INVALID', fields: { reason: 'overlap' } });
    const late = await postOps(job.id, { baseRevision: 1, ops: [{ type: 'update', id: cues[2]!.id, patch: { endMs: MEDIA.durationMs + 1 } }] });
    expect(await errorOf(late)).toMatchObject({ code: 'CUE_INVALID', fields: { id: cues[2]!.id, reason: 'past_end' } });
    expect((await cuesOf(job.id)).map((c) => c.targetText)).toEqual(cues.map((c) => c.targetText));
    expect((await videoJobRow(job.id))!.cueRevision).toBe(1);
  });

  it.each([
    ['không có thao tác', { baseRevision: 1, ops: [] }],
    ['quá 20.000 thao tác', { baseRevision: 1, ops: Array.from({ length: 20_001 }, () => ({ type: 'delete', id: '00000000-0000-4000-8000-000000000000' })) }],
    ['thiếu phiên bản', { ops: [{ type: 'delete', id: '00000000-0000-4000-8000-000000000000' }] }],
    ['trường lạ trong patch', { baseRevision: 1, ops: [{ type: 'update', id: '00000000-0000-4000-8000-000000000000', patch: { jobId: 'x' } }] }],
    ['id không phải uuid', { baseRevision: 1, ops: [{ type: 'delete', id: '1' }] }],
  ])('yêu cầu sai dạng (%s) → 422', async (_name, body) => {
    const { job } = await readyJob();
    const res = await postOps(job.id, body);
    expect(res.status).toBe(422);
    expect((await errorOf(res)).code).toBe('VALIDATION');
  });

  it('lô không đổi gì thì giữ nguyên phiên bản', async () => {
    const { job, cues } = await readyJob();
    const res = await postOps(job.id, { baseRevision: 1, ops: [{ type: 'update', id: cues[0]!.id, patch: { targetText: cues[0]!.targetText } }] });
    expect(await res.json()).toEqual({ revision: 1 });
  });

  it.each([
    ['đang dịch', { status: 'translating' as const }],
    ['đang chờ dịch lại', { status: 'queued' as const }],
    ['bị gián đoạn', { status: 'interrupted' as const }],
    ['chưa có kết quả', { status: 'failed' as const, cueRun: 0 }],
  ])('việc %s → VIDEO_NOT_EDITABLE', async (_name, over) => {
    const { job, cues } = await readyJob(makeCues(2), over);
    const res = await postOps(job.id, { baseRevision: 1, ops: [{ type: 'delete', id: cues[0]!.id }] });
    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe('VIDEO_NOT_EDITABLE');
    expect(await cuesOf(job.id)).toHaveLength(2);
  });

  it('lượt dịch lại thất bại: kịch bản cũ vẫn sửa được', async () => {
    const { job, cues } = await readyJob(makeCues(2), { status: 'failed', translationRun: 2 });
    expect((await postOps(job.id, { baseRevision: 1, ops: [{ type: 'delete', id: cues[0]!.id }] })).status).toBe(200);
  });

  it('hạn mức 500 MB đã đầy vẫn lưu được bản sửa (FR-055)', async () => {
    const { job, cues } = await readyJob();
    await getDb()
      .update(users)
      .set({ storageUsedBytes: 600 * 1024 * 1024 })
      .where(eq(users.id, user.id));
    const res = await postOps(job.id, { baseRevision: 1, ops: [{ type: 'update', id: cues[0]!.id, patch: { targetText: 'dài thêm '.repeat(50) } }] });
    expect(res.status).toBe(200);
    expect(await storageUsed()).toBeGreaterThan(600 * 1024 * 1024);
  });

  it('kịch bản 3.000 cue: thay toàn bộ câu dịch trong một lô, hoàn tác cũng trong một lô (SC-006)', async () => {
    const { job, cues } = await readyJob(makeCues(3000));
    const started = Date.now();
    const res = await postOps(job.id, { baseRevision: 1, ops: cues.map((c) => ({ type: 'update', id: c.id, patch: { targetText: `${c.targetText} Đã thay.` } })) });
    expect(res.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(5000);
    const after = ((await (await getList(job.id)).json()) as CueListDto).cues;
    expect(after).toHaveLength(3000);
    expect(after.at(-1)!.targetText).toBe('Câu số 2999. Đã thay.');
    const back = await postOps(job.id, { baseRevision: 2, ops: cues.map((c) => ({ type: 'update', id: c.id, patch: { targetText: c.targetText, timing: c.timing, flags: c.flags } })) });
    expect(back.status).toBe(200);
    expect(((await (await getList(job.id)).json()) as CueListDto).cues).toEqual(cues);
    expect((await videoJobRow(job.id))!.scriptBytes).toBe(bytesOf(cues));
  }, 60_000);
});
