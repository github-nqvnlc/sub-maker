import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '@/lib/db';
import { overlayAudios, overlayJobs, systemSettings, users } from '@/lib/db/schema';
import { expectedStoredBytes, looksLike, MAX_OVERLAY_AUDIO_BYTES } from '@/lib/overlay/audio-service';
import { getObjectBuffer, headObject } from '@/lib/storage/client';
import { storageKeys } from '@/lib/storage/keys';
import { MAX_AUDIO_INTERRUPTIONS, runPrepareOverlayAudio, type PrepareAudioOptions } from '@/worker/jobs/prepare-overlay-audio';
import { runRenderOverlay } from '@/worker/jobs/render-overlay';
import { stopBoss } from '@/worker/queues';
import { sweepStaleOverlayAudios } from '@/worker/sweeper';
import { clearRateLimits, createAdmin, createUser, resetDb, TestClient, type TestUser } from './helpers';
import { FAST_RENDER, fakeRender } from './overlay-fake-render';
import { createOverlayJob, keysOf, overlayRow, postOverlayJob, uploadSrt, usedBytes } from './overlay-helpers';
import { newProject } from './voice-helpers';

/** Tệp âm thanh tải lên (spec 005, US5, T075): chuyển MP3, hạn mức, từ chối, phục hồi, xóa, cô lập. Tệp ≤ 10 giây. */
const FAST: PrepareAudioOptions = { heartbeatMs: 30, retry: { baseMs: 5, maxMs: 20 }, freeBytes: async () => 10 ** 13 };
const AUDIO_MS = 3000;

let dir: string;
const files: Record<'mp3' | 'wav' | 'm4a', Buffer> = { mp3: Buffer.alloc(0), wav: Buffer.alloc(0), m4a: Buffer.alloc(0) };
let user: TestUser;
let projectId: string;

beforeAll(async () => {
  await resetDb();
  dir = await mkdtemp(path.join(os.tmpdir(), 'overlay-audio-test-'));
  const codec = { mp3: ['-c:a', 'libmp3lame', '-b:a', '64k'], wav: ['-c:a', 'pcm_s16le'], m4a: ['-c:a', 'aac'] };
  for (const ext of ['mp3', 'wav', 'm4a'] as const) {
    const out = path.join(dir, `tone.${ext}`);
    await promisify(execFile)('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${AUDIO_MS / 1000}`, ...codec[ext], '-y', out]);
    files[ext] = await readFile(out);
  }
}, 60_000);
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
  await stopBoss();
});
beforeEach(async () => {
  await clearRateLimits();
  await getDb().delete(systemSettings);
  user = await createUser();
  projectId = await newProject(user);
});

const upload = (name: string, data: Buffer, u: TestUser = user, p: string = projectId): Promise<Response> => {
  const form = new FormData();
  form.set('file', new File([new Uint8Array(data)], name));
  return u.client.post(`/api/projects/${p}/overlay/audios`, { form });
};
const uploaded = async (name = 'giong.mp3', data = files.mp3): Promise<string> => {
  const res = await upload(name, data);
  expect(res.status).toBe(202);
  return ((await res.json()) as { id: string }).id;
};
const ready = async (): Promise<string> => {
  const id = await uploaded();
  await runPrepareOverlayAudio(id, FAST);
  expect((await row(id))!.status).toBe('ready');
  return id;
};
const row = async (id: string) => (await getDb().select().from(overlayAudios).where(eq(overlayAudios.id, id)))[0];
const set = (id: string, v: Partial<typeof overlayAudios.$inferInsert>) => getDb().update(overlayAudios).set(v).where(eq(overlayAudios.id, id));
const errorCode = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;
const setting = (key: string, value: number) => getDb().insert(systemSettings).values({ key, value });

describe('chuyển đổi', () => {
  it.each(['mp3', 'wav', 'm4a'] as const)('.%s → MP3 sẵn sàng, dung lượng thật được tính hạn mức, tệp tạm được dọn', async (ext) => {
    const before = await usedBytes(user.id);
    const res = await upload(`Giọng đọc.${ext}`, files[ext]);
    expect(res.status).toBe(202);
    const dto = (await res.json()) as { id: string; status: string; originalName: string; sizeBytes: number };
    expect(dto).toMatchObject({ status: 'processing', originalName: `Giọng đọc.${ext}`, sizeBytes: 0 });
    // tệp tạm chưa tính vào hạn mức
    expect(await usedBytes(user.id)).toBe(before);
    expect(await keysOf(user.id, 'overlay-tmp/')).toHaveLength(1);

    await runPrepareOverlayAudio(dto.id, FAST);
    const r = (await row(dto.id))!;
    expect(r).toMatchObject({ status: 'ready', errorCode: null, tempStorageKey: null, storageKey: storageKeys.overlayAudio(user.id, dto.id) });
    expect(Math.abs(r.durationMs! - AUDIO_MS)).toBeLessThanOrEqual(120);
    const obj = await getObjectBuffer(r.storageKey!);
    expect(obj.length).toBe(r.sizeBytes);
    expect(await usedBytes(user.id)).toBe(before + r.sizeBytes);
    expect(await keysOf(user.id, 'overlay-tmp/')).toEqual([]);
    // thẻ Xing/Info để trình duyệt tua chính xác
    expect(obj.subarray(0, 4096).toString('latin1')).toMatch(/Xing|Info/);
  }, 30_000);

  it('danh sách mới nhất trước, đủ trạng thái và dung lượng; phát được theo Range', async () => {
    const a = await ready();
    const b = await uploaded('thu-hai.wav', files.wav);
    const list = (await (await user.client.get(`/api/projects/${projectId}/overlay/audios`)).json()) as Array<{ id: string; status: string; durationMs: number | null }>;
    expect(list.map((x) => [x.id, x.status])).toEqual([
      [b, 'processing'],
      [a, 'ready'],
    ]);
    const part = await user.client.get(`/api/overlay/audios/${a}/stream`, { headers: { range: 'bytes=0-99' } });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-type')).toBe('audio/mpeg');
    expect((await part.arrayBuffer()).byteLength).toBe(100);
    // chưa sẵn sàng → như không tồn tại
    expect((await user.client.get(`/api/overlay/audios/${b}/stream`)).status).toBe(404);
  }, 30_000);

  it('dùng làm voice: mốc theo tệp phụ đề, xuất được video; chưa xong thì 409', async () => {
    const fileId = await uploadSrt(user, projectId);
    const id = await uploaded('giong.wav', files.wav);
    const pending = await user.client.get(`/api/projects/${projectId}/overlay/timeline?audioId=${id}&fileId=${fileId}`);
    expect(pending.status).toBe(409);
    expect(await errorCode(pending)).toBe('AUDIO_NOT_READY');
    expect(await errorCode(await postOverlayJob(user, projectId, { fileId, audioId: id }))).toBe('AUDIO_NOT_READY');

    await runPrepareOverlayAudio(id, FAST);
    const tl = (await (await user.client.get(`/api/projects/${projectId}/overlay/timeline?audioId=${id}&fileId=${fileId}`)).json()) as {
      durationMs: number;
      cues: Array<{ origin: string; endMs: number }>;
      warnings: Array<{ code: string }>;
    };
    expect(tl.cues.length).toBeGreaterThan(0);
    for (const c of tl.cues) expect(c).toMatchObject({ origin: 'file' });
    expect(Math.max(...tl.cues.map((c) => c.endMs))).toBeLessThanOrEqual(tl.durationMs);
    // tiếng 3 giây, phụ đề gần 10 giây
    expect(tl.warnings.map((w) => w.code)).toContain('LENGTH_MISMATCH');

    const job = await createOverlayJob(user, projectId, { fileId, audioId: id });
    await runRenderOverlay(job.id, { ...FAST_RENDER, spawnRender: fakeRender().spawn });
    expect((await overlayRow(job.id))!.status).toBe('completed');
  }, 30_000);
});

describe('từ chối', () => {
  it('sai đuôi, tệp giả đuôi, tệp rỗng → 422 và không để lại gì', async () => {
    for (const [name, data] of [
      ['giong.ogg', files.mp3],
      ['khong-duoi', files.mp3],
      ['gia.mp3', Buffer.from('đây là văn bản, không phải âm thanh')],
      ['gia.wav', files.mp3],
      ['gia.m4a', files.wav],
      ['rong.mp3', Buffer.alloc(0)],
    ] as const) {
      const res = await upload(name, data);
      expect([name, res.status]).toEqual([name, 422]);
      expect(await errorCode(res)).toBe('OVERLAY_AUDIO_UNSUPPORTED');
    }
    expect(await getDb().select().from(overlayAudios).where(eq(overlayAudios.ownerId, user.id))).toEqual([]);
    expect(await keysOf(user.id, 'overlay')).toEqual([]);
    const empty = new FormData();
    expect((await user.client.post(`/api/projects/${projectId}/overlay/audios`, { form: empty })).status).toBe(422);
  });

  it('lớn hơn 100 MB → 413 theo Content-Length trước khi đọc nội dung', async () => {
    const res = await user.client.post(`/api/projects/${projectId}/overlay/audios`, { body: 'x', headers: { 'content-length': String(MAX_OVERLAY_AUDIO_BYTES + 2 * 1024 * 1024) } });
    expect(res.status).toBe(413);
    expect(await errorCode(res)).toBe('OVERLAY_AUDIO_TOO_LARGE');
  });

  it('tệp hỏng → failed AUDIO_UNREADABLE, dọn sạch, không tính hạn mức', async () => {
    const before = await usedBytes(user.id);
    for (const [name, data] of [
      ['hong.mp3', Buffer.concat([Buffer.from('ID3'), Buffer.alloc(3000, 1)])],
      ['hong.wav', Buffer.concat([files.wav.subarray(0, 12), Buffer.alloc(2000, 3)])],
      ['hong.m4a', Buffer.concat([files.m4a.subarray(0, 32), Buffer.alloc(2000, 5)])],
    ] as const) {
      const id = await uploaded(name, data);
      await runPrepareOverlayAudio(id, FAST);
      expect([name, await row(id)]).toEqual([name, expect.objectContaining({ status: 'failed', errorCode: 'AUDIO_UNREADABLE', tempStorageKey: null })]);
    }
    expect(await usedBytes(user.id)).toBe(before);
    expect(await keysOf(user.id, 'overlay')).toEqual([]);
  }, 30_000);

  it('dài hơn giới hạn của Administrator → failed AUDIO_TOO_LONG', async () => {
    // giới hạn nhỏ nhất là 1 phút: tạo tệp 61 giây im lặng rất nhẹ
    await setting('overlayMaxMinutes', 1);
    const out = path.join(dir, 'dai.mp3');
    await promisify(execFile)('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=8000:cl=mono', '-t', '61', '-c:a', 'libmp3lame', '-b:a', '8k', '-y', out]);
    const id = await uploaded('dai.mp3', await readFile(out));
    await runPrepareOverlayAudio(id, FAST);
    expect(await row(id)).toMatchObject({ status: 'failed', errorCode: 'AUDIO_TOO_LONG' });

    // dài đúng bằng giới hạn (kể cả phần đệm của MP3) thì được nhận, thời lượng không vượt giới hạn
    await promisify(execFile)('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=8000:cl=mono', '-t', '60', '-c:a', 'libmp3lame', '-b:a', '8k', '-y', out]);
    const exact = await uploaded('vua-du.mp3', await readFile(out));
    await runPrepareOverlayAudio(exact, FAST);
    const r = (await row(exact))!;
    expect(r.status).toBe('ready');
    expect(r.durationMs!).toBeLessThanOrEqual(60_000);
    expect(r.durationMs!).toBeGreaterThan(59_800);
  }, 30_000);

  it('không đủ chỗ: chặn lúc tải; hết chỗ trong lúc xử lý → failed QUOTA_EXCEEDED, không lưu đối tượng', async () => {
    await setting('userQuotaBytes', 10 * 1024 * 1024);
    await getDb().update(users).set({ storageUsedBytes: 10 * 1024 * 1024 - 1000 }).where(eq(users.id, user.id));
    const res = await upload('giong.mp3', files.mp3);
    expect(res.status).toBe(409);
    const err = ((await res.json()) as { error: { code: string; fields: Record<string, string> } }).error;
    expect(err.code).toBe('QUOTA_EXCEEDED');
    expect(Number(err.fields.remainingBytes)).toBe(1000);
    expect(Number(err.fields.needBytes)).toBe(files.mp3.length - 1000);

    await getDb().update(users).set({ storageUsedBytes: 0 }).where(eq(users.id, user.id));
    const id = await uploaded();
    const full = 10 * 1024 * 1024 - 10;
    await getDb().update(users).set({ storageUsedBytes: full }).where(eq(users.id, user.id));
    await runPrepareOverlayAudio(id, FAST);
    expect(await row(id)).toMatchObject({ status: 'failed', errorCode: 'QUOTA_EXCEEDED', storageKey: null });
    expect(await usedBytes(user.id)).toBe(full);
    expect(await keysOf(user.id, 'overlay')).toEqual([]);
  }, 30_000);

  it('tối đa 3 tệp đang xử lý mỗi User, kể cả khi gửi cùng lúc', async () => {
    const res = await Promise.all(Array.from({ length: 5 }, (_, i) => upload(`t${i}.mp3`, files.mp3)));
    expect(res.map((r) => r.status).sort()).toEqual([202, 202, 202, 429, 429]);
    expect(await errorCode(res.find((r) => r.status === 429)!)).toBe('OVERLAY_TOO_MANY_UPLOADS');
  });

  it('nhận biết đầu tệp và ước tính dung lượng WAV theo tốc độ byte', () => {
    expect(looksLike('mp3', files.mp3)).toBe(true);
    expect(looksLike('wav', files.wav)).toBe(true);
    expect(looksLike('m4a', files.m4a)).toBe(true);
    expect(looksLike('wav', files.m4a)).toBe(false);
    // 44100 Hz mono 16 bit = 88200 byte/giây → MP3 192 kbps 24000 byte/giây
    expect(expectedStoredBytes('wav', files.wav.length, files.wav)).toBe(Math.ceil((files.wav.length / 88_200) * 24_000));
    expect(expectedStoredBytes('mp3', 1234, files.mp3)).toBe(1234);
  });
});

describe('lỗi tạm thời và phục hồi', () => {
  it('kho lưu trữ lỗi tạm thời được thử lại; lỗi mãi thì STORAGE_UNAVAILABLE', async () => {
    const id = await uploaded();
    let calls = 0;
    const { putObjectStream } = await import('@/lib/storage/client');
    await runPrepareOverlayAudio(id, {
      ...FAST,
      putObject: async (...a) => {
        if (++calls < 3) throw new Error('kho lỗi');
        return putObjectStream(...a);
      },
    });
    expect(calls).toBe(3);
    expect((await row(id))!.status).toBe('ready');

    const other = await uploaded();
    await runPrepareOverlayAudio(other, { ...FAST, putObject: async () => Promise.reject(new Error('kho lỗi')) });
    expect(await row(other)).toMatchObject({ status: 'failed', errorCode: 'STORAGE_UNAVAILABLE' });
  }, 30_000);

  it('worker chết giữa chừng: sweeper xếp lại, lần sau chạy xong; quá 3 lần gián đoạn → failed', async () => {
    const id = await uploaded();
    const old = new Date(Date.now() - 120_000);
    // còn nhịp tim: không đụng tới, và không worker nào khác nhận được
    await set(id, { heartbeatAt: new Date() });
    expect(await sweepStaleOverlayAudios({ requeue: async () => undefined })).toEqual({ requeued: [] });
    await runPrepareOverlayAudio(id, FAST);
    expect((await row(id))!.status).toBe('processing');

    await set(id, { heartbeatAt: old });
    const requeued: string[] = [];
    expect((await sweepStaleOverlayAudios({ requeue: async (x) => requeued.push(x) })).requeued).toEqual([id]);
    expect(requeued).toEqual([id]);
    await runPrepareOverlayAudio(id, FAST);
    expect(await row(id)).toMatchObject({ status: 'ready', interruptions: 1 });

    const bad = await uploaded();
    await set(bad, { heartbeatAt: old, interruptions: MAX_AUDIO_INTERRUPTIONS });
    await runPrepareOverlayAudio(bad, FAST);
    expect(await row(bad)).toMatchObject({ status: 'failed', errorCode: 'INTERNAL' });
    expect(await keysOf(user.id, 'overlay-tmp/')).toEqual([]);
  }, 30_000);

  it('mất việc trong hàng đợi (chưa ai nhận sau 15 phút) được xếp lại; mất tệp tạm → AUDIO_UNREADABLE', async () => {
    const id = await uploaded();
    expect((await sweepStaleOverlayAudios({ requeue: async () => undefined })).requeued).toEqual([]);
    await set(id, { createdAt: new Date(Date.now() - 16 * 60_000) });
    expect((await sweepStaleOverlayAudios({ requeue: async () => undefined })).requeued).toEqual([id]);
    const { deleteObject } = await import('@/lib/storage/client');
    await deleteObject((await row(id))!.tempStorageKey!);
    await runPrepareOverlayAudio(id, FAST);
    expect(await row(id)).toMatchObject({ status: 'failed', errorCode: 'AUDIO_UNREADABLE' });
  });

  it('chết giữa ghi đối tượng và hoàn tất: lần sau ghi đè cùng khóa, hạn mức chỉ bị trừ một lần', async () => {
    const before = await usedBytes(user.id);
    const id = await uploaded();
    const { putObjectStream } = await import('@/lib/storage/client');
    const key = storageKeys.overlayAudio(user.id, id);
    // lượt 1: ghi xong đối tượng rồi "chết" (lượt khác nhận lại trước khi lượt này hoàn tất)
    await runPrepareOverlayAudio(id, {
      ...FAST,
      heartbeatMs: 60_000,
      putObject: async (...a) => {
        await putObjectStream(...a);
        await set(id, { interruptions: 1, heartbeatAt: new Date(Date.now() - 120_000) });
      },
    });
    expect((await row(id))!.status).toBe('processing');
    expect(await headObject(key)).not.toBeNull();
    expect(await usedBytes(user.id)).toBe(before);

    await runPrepareOverlayAudio(id, FAST);
    const r = (await row(id))!;
    expect(r).toMatchObject({ status: 'ready', interruptions: 2 });
    expect(await usedBytes(user.id)).toBe(before + r.sizeBytes);
    // chạy lại trên bản ghi đã xong không làm gì
    await runPrepareOverlayAudio(id, FAST);
    expect(await usedBytes(user.id)).toBe(before + r.sizeBytes);
  }, 30_000);
});

describe('xóa', () => {
  it('trả lại hạn mức, xóa đối tượng; tiến trình đang chờ dùng tệp này chuyển SOURCE_DELETED', async () => {
    const fileId = await uploadSrt(user, projectId);
    const before = await usedBytes(user.id);
    const id = await ready();
    const job = await createOverlayJob(user, projectId, { fileId, audioId: id });
    const res = await user.client.post('/api/overlay/audios/bulk-delete', { json: { ids: [id] } });
    expect(await res.json()).toEqual({ deleted: [id], busy: [], notFound: [] });
    expect(await usedBytes(user.id)).toBe(before);
    expect(await keysOf(user.id, 'overlay/audio')).toEqual([]);
    await runRenderOverlay(job.id, { ...FAST_RENDER, spawnRender: fakeRender().spawn });
    expect(await overlayRow(job.id)).toMatchObject({ status: 'failed', errorCode: 'SOURCE_DELETED' });
  }, 30_000);

  it('xóa khi đang xử lý: việc nền dừng, không để lại đối tượng hay hạn mức', async () => {
    const before = await usedBytes(user.id);
    const id = await uploaded();
    const { putObjectStream } = await import('@/lib/storage/client');
    await runPrepareOverlayAudio(id, {
      ...FAST,
      putObject: async (...a) => {
        await putObjectStream(...a);
        expect((await user.client.post('/api/overlay/audios/bulk-delete', { json: { ids: [id] } })).status).toBe(200);
      },
    });
    expect(await row(id)).toBeUndefined();
    expect(await usedBytes(user.id)).toBe(before);
    expect(await keysOf(user.id, 'overlay')).toEqual([]);
  }, 30_000);

  it('xóa Project dọn cả tệp sẵn sàng lẫn tệp tạm', async () => {
    const before = await usedBytes(user.id);
    await ready();
    await uploaded('dang-xu-ly.wav', files.wav);
    expect((await user.client.delete(`/api/projects/${projectId}`)).status).toBe(204);
    expect(await keysOf(user.id, 'overlay')).toEqual([]);
    expect(await usedBytes(user.id)).toBeLessThanOrEqual(before);
  }, 30_000);
});

describe('cô lập', () => {
  it('User khác và Administrator nhận 404 ở danh sách, tải lên, phát; xóa báo không tìm thấy; chưa đăng nhập 401', async () => {
    const id = await ready();
    const other = await createUser();
    const admin = await createAdmin();
    const bytes = await usedBytes(user.id);
    for (const u of [other, admin]) {
      expect((await u.client.get(`/api/projects/${projectId}/overlay/audios`)).status).toBe(404);
      expect((await upload('x.mp3', files.mp3, u)).status).toBe(404);
      expect((await u.client.get(`/api/overlay/audios/${id}/stream`)).status).toBe(404);
      expect((await u.client.get(`/api/overlay/audios/${id}/stream`, { headers: { range: 'bytes=0-1' } })).status).toBe(404);
      expect(await (await u.client.post('/api/overlay/audios/bulk-delete', { json: { ids: [id] } })).json()).toEqual({ deleted: [], busy: [], notFound: [id] });
    }
    const anon = new TestClient();
    expect((await anon.get(`/api/projects/${projectId}/overlay/audios`)).status).toBe(401);
    expect((await anon.get(`/api/overlay/audios/${id}/stream`)).status).toBe(401);
    expect((await anon.post('/api/overlay/audios/bulk-delete', { json: { ids: [id] } })).status).toBe(401);
    expect(await usedBytes(user.id)).toBe(bytes);

    // dùng tệp của A trong Project của B
    const p = await newProject(other);
    const f = await uploadSrt(other, p);
    expect((await postOverlayJob(other, p, { fileId: f, audioId: id })).status).toBe(404);
    // tệp của một Project khác của chính mình cũng không dùng được
    const mine = await newProject(user);
    const mineFile = await uploadSrt(user, mine);
    expect((await postOverlayJob(user, mine, { fileId: mineFile, audioId: id })).status).toBe(404);
    expect((await user.client.get('/api/overlay/audios/khong-phai-uuid/stream')).status).toBe(404);
    expect(await getDb().select().from(overlayJobs).where(eq(overlayJobs.ownerId, other.id))).toEqual([]);
  }, 30_000);
});
