import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { expectedDurationMs, startMockProvider, type MockProvider } from '../../mock-provider/server';
import { getDb } from '@/lib/db';
import { aiProviderConfigs, voices } from '@/lib/db/schema';
import { deleteObject } from '@/lib/storage/client';
import { runGenerateVoice } from '@/worker/jobs/generate-voice';
import { stopBoss } from '@/worker/queues';
import { TestClient, clearRateLimits, createAdmin, createUser, resetDb, type TestUser } from './helpers';
import { FAST, SCRIPT_4, newProject, putGlobalConfig, startJob, uploadScript, voiceOfJob } from './voice-helpers';

let mock: MockProvider;
let admin: TestUser;
let a: TestUser;
let voiceId: string;
let mp3Size: number;

const LINES = SCRIPT_4.split('\n');

beforeAll(async () => {
  mock = await startMockProvider();
  await resetDb();
  admin = await createAdmin();
  await getDb().delete(aiProviderConfigs);
  await putGlobalConfig(admin, mock, 'ok');
  a = await createUser({ name: 'Người nghe' });
  const pid = await newProject(a);
  const job = await startJob(a, pid, (await uploadScript(a, pid, SCRIPT_4)).id);
  await runGenerateVoice(job.id, FAST);
  const v = (await voiceOfJob(job.id))!;
  voiceId = v.id;
  mp3Size = v.sizeBytes;
});
afterAll(async () => {
  await mock.close();
  await stopBoss();
});
beforeEach(async () => {
  await clearRateLimits();
});

describe('GET /api/voices/{id}', () => {
  it('trả thông tin và từng đoạn kèm văn bản + mốc thời gian chính xác để đồng bộ highlight', async () => {
    const res = await a.client.get(`/api/voices/${voiceId}`);
    expect(res.status).toBe(200);
    const v = await res.json();
    expect(v).toMatchObject({ id: voiceId, sizeBytes: mp3Size });
    expect(v.segments).toHaveLength(4);
    let cursor = 0;
    LINES.forEach((line, i) => {
      const d = expectedDurationMs(line);
      expect(v.segments[i]).toEqual({ idx: i, text: line, startMs: cursor, endMs: cursor + d });
      cursor += d + 380;
    });
    expect(v.durationMs).toBe(cursor - 380);
    expect(v.fileId).toBeTruthy();
    expect(v.projectId).toBeTruthy();
  });

  it('chưa đăng nhập → 401; User khác → 404; id sai → 404', async () => {
    expect((await new TestClient().get(`/api/voices/${voiceId}`)).status).toBe(401);
    const b = await createUser();
    expect((await b.client.get(`/api/voices/${voiceId}`)).status).toBe(404);
    expect((await a.client.get('/api/voices/khong-phai-uuid')).status).toBe(404);
    expect((await a.client.get('/api/voices/00000000-0000-4000-8000-000000000000')).status).toBe(404);
  });
});

describe('GET /api/voices/{id}/audio (proxy có Range)', () => {
  it('200: toàn bộ file mp3 hợp lệ, Accept-Ranges, không cache dùng chung', async () => {
    const res = await a.client.get(`/api/voices/${voiceId}/audio`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('audio/mpeg');
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(res.headers.get('cache-control')).toContain('private');
    expect(res.headers.get('content-length')).toBe(String(mp3Size));
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.length).toBe(mp3Size);
    expect(buf.subarray(0, 3).toString('latin1') === 'ID3' || (buf[0] === 0xff && (buf[1]! & 0xe0) === 0xe0)).toBe(true);
  });

  it('206: Range bytes=0-99, bytes=100-199 và suffix bytes=-50 trả đúng đoạn dữ liệu', async () => {
    const whole = Buffer.from(await (await a.client.get(`/api/voices/${voiceId}/audio`)).arrayBuffer());
    const part = async (range: string) => {
      const res = await a.client.get(`/api/voices/${voiceId}/audio`, { headers: { range } });
      return { res, buf: Buffer.from(await res.arrayBuffer()) };
    };
    const first = await part('bytes=0-99');
    expect(first.res.status).toBe(206);
    expect(first.res.headers.get('content-range')).toBe(`bytes 0-99/${mp3Size}`);
    expect(first.buf.equals(whole.subarray(0, 100))).toBe(true);

    const mid = await part('bytes=100-199');
    expect(mid.buf.equals(whole.subarray(100, 200))).toBe(true);

    const tail = await part('bytes=-50');
    expect(tail.res.headers.get('content-range')).toBe(`bytes ${mp3Size - 50}-${mp3Size - 1}/${mp3Size}`);
    expect(tail.buf.equals(whole.subarray(mp3Size - 50))).toBe(true);

    const open = await part(`bytes=${mp3Size - 10}-`);
    expect(open.buf.equals(whole.subarray(mp3Size - 10))).toBe(true);
  });

  it('416 khi Range nằm ngoài file', async () => {
    const res = await a.client.get(`/api/voices/${voiceId}/audio`, { headers: { range: `bytes=${mp3Size + 10}-${mp3Size + 20}` } });
    expect(res.status).toBe(416);
    expect(res.headers.get('content-range')).toBe(`bytes */${mp3Size}`);
  });

  it('download=true trả Content-Disposition attachment với tên tệp .mp3 an toàn', async () => {
    const res = await a.client.get(`/api/voices/${voiceId}/audio?download=true`);
    expect(res.status).toBe(200);
    const cd = res.headers.get('content-disposition')!;
    expect(cd).toContain('attachment');
    expect(cd).toContain('.mp3');
    const filename = /filename="([^"]*)"/.exec(cd)![1]!;
    expect(filename.endsWith('.mp3')).toBe(true);
    expect(filename).not.toMatch(/[\\/:*?<>|]/); // không có ký tự nguy hiểm cho tên tệp
    expect(filename).toMatch(/^[\x20-\x7e]+$/); // tên ASCII dự phòng; tên đầy đủ nằm ở filename*
    expect(cd).toContain("filename*=UTF-8''");
    await res.arrayBuffer();
  });

  it('KHÔNG truy cập được khi chưa đăng nhập hoặc là User khác (không rò rỉ audio)', async () => {
    expect((await new TestClient().get(`/api/voices/${voiceId}/audio`)).status).toBe(401);
    const b = await createUser();
    const res = await b.client.get(`/api/voices/${voiceId}/audio`);
    expect(res.status).toBe(404);
    expect((await b.client.get(`/api/voices/${voiceId}/audio`, { headers: { range: 'bytes=0-9' } })).status).toBe(404);
  });

  it('đối tượng audio đã mất trên MinIO → 404 thân thiện (không lỗi 500)', async () => {
    const pid = await newProject(a);
    const job = await startJob(a, pid, (await uploadScript(a, pid, 'Một câu thử.')).id);
    await runGenerateVoice(job.id, FAST);
    const v = (await voiceOfJob(job.id))!;
    await deleteObject(v.storageKey);
    const res = await a.client.get(`/api/voices/${v.id}/audio`);
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('NOT_FOUND');
    expect((await getDb().select().from(voices).where(eq(voices.id, v.id)))).toHaveLength(1);
  });
});
