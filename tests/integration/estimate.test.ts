import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startMockProvider, type MockProvider } from '../../mock-provider/server';
import { getDb } from '@/lib/db';
import { aiProviderConfigs, users } from '@/lib/db/schema';
import { runGenerateVoice } from '@/worker/jobs/generate-voice';
import { stopBoss } from '@/worker/queues';
import { TestClient, clearRateLimits, createAdmin, createUser, resetDb, type TestUser } from './helpers';
import { FAST, newProject, putGlobalConfig, startJob, uploadScript } from './voice-helpers';

const fixture = (name: string) => fs.readFileSync(path.resolve(process.cwd(), 'tests/fixtures', name), 'utf8');
const TIMED = { mode: 'timed', mergeCues: true };

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
  user = await createUser({ name: 'Người ước tính' });
});

async function setup(name: string, text: string) {
  const projectId = await newProject(user);
  const file = await uploadScript(user, projectId, text, name);
  return { projectId, file };
}
const estimate = (fileId: string, body: Record<string, unknown> = {}, u: TestUser = user) => u.client.post(`/api/files/${fileId}/estimate`, { json: body });

describe('POST /api/files/{id}/estimate (spec 003, FR-008)', () => {
  it('chế độ khớp mốc: số cue, đơn vị, ký tự đọc thực, yêu cầu, thời lượng = thời lượng phụ đề', async () => {
    const { file } = await setup('sample-10s.srt', fixture('sample-10s.srt'));
    const res = await estimate(file.id, { timing: TIMED });
    expect(res.status).toBe(200);
    const e = await res.json();
    expect(e).toMatchObject({ cues: 3, units: 3, chars: 122, billableChars: 122, cachedUnits: 0, requests: 3, audioMs: 9772, quotaOk: true });
    expect(e.outputBytes).toBeGreaterThan(0);
    expect(e.etaMs).toBeGreaterThan(0);
  });

  it('ghép cue cùng câu giảm số đơn vị, tắt ghép thì mỗi cue một đơn vị', async () => {
    const { file } = await setup('sample-synthetic.srt', fixture('sample-synthetic.srt'));
    const merged = await (await estimate(file.id, { timing: TIMED })).json();
    const separate = await (await estimate(file.id, { timing: { mode: 'timed', mergeCues: false } })).json();
    expect(merged).toMatchObject({ cues: 12, units: 10, requests: 10 });
    expect(separate).toMatchObject({ cues: 12, units: 11, requests: 11 });
    // ghép thêm đúng một khoảng trắng nối giữa hai cue của đơn vị đầu
    expect(merged.chars).toBe(separate.chars + 1);
  });

  it('chế độ đọc liên tục: không có cue, đơn vị = đoạn; văn bản trùng chỉ tính một lần', async () => {
    const { file } = await setup('kich-ban.txt', 'Câu giống nhau.\nCâu giống nhau.\nCâu khác hẳn.');
    const e = await (await estimate(file.id)).json();
    expect(e).toMatchObject({ cues: 0, units: 3, requests: 2, cachedUnits: 0 });
    expect(e.chars).toBe('Câu giống nhau.'.length * 2 + 'Câu khác hẳn.'.length);
    expect(e.billableChars).toBe('Câu giống nhau.'.length + 'Câu khác hẳn.'.length);
  });

  it('đơn vị đã có trong cache của chính người dùng được loại khỏi yêu cầu và ký tự phải trả phí', async () => {
    const { projectId, file } = await setup('sample-10s.srt', fixture('sample-10s.srt'));
    const job = await startJob(user, projectId, file.id, { timing: TIMED });
    await runGenerateVoice(job.id, FAST);
    const e = await (await estimate(file.id, { timing: TIMED })).json();
    expect(e).toMatchObject({ units: 3, cachedUnits: 3, requests: 0, billableChars: 0, chars: 122 });
    // đổi giọng/tốc độ thì cache cũ không dùng được
    const other = await (await estimate(file.id, { timing: TIMED, speed: 1.2 })).json();
    expect(other).toMatchObject({ cachedUnits: 0, requests: 3 });
  });

  it('thời gian xử lý bị chặn bởi giới hạn yêu cầu/phút (rpm*); ghi đè bằng cài đặt hệ thống', async () => {
    const { file } = await setup('sample-synthetic.srt', fixture('sample-synthetic.srt')); // 10 đơn vị → 10 yêu cầu
    const dflt = await (await estimate(file.id, { timing: TIMED })).json();
    expect(dflt.requests).toBe(10);
    expect(dflt.etaMs).toBe(60_000); // mặc định catalog 30 yêu cầu/phút → 1 phút
    expect((await admin.client.put('/api/admin/settings', { json: { rpmFptMarketplace: 5 } })).status).toBe(200);
    const slow = await (await estimate(file.id, { timing: TIMED })).json();
    expect(slow.etaMs).toBe(120_000); // 10 yêu cầu ở 5/phút → 2 phút
    await admin.client.put('/api/admin/settings', { json: { rpmFptMarketplace: 0 } });
  });

  it('không bịa số tiền khi cấu hình AI chưa có đơn giá; có đơn giá thì = ký tự phải trả phí × đơn giá', async () => {
    const { file } = await setup('sample-10s.srt', fixture('sample-10s.srt'));
    const noPrice = await (await estimate(file.id, { timing: TIMED })).json();
    expect(noPrice).toMatchObject({ priceConfigured: false, price: null });

    await putGlobalConfig(admin, mock, 'ok', { pricePerMillionChars: 16.5 });
    const priced = await (await estimate(file.id, { timing: TIMED })).json();
    expect(priced.priceConfigured).toBe(true);
    expect(priced.price).toBeCloseTo((122 / 1_000_000) * 16.5, 10);
  });

  it('dung lượng ước tính vượt hạn mức còn lại → quotaOk=false kèm needBytes', async () => {
    const { file } = await setup('sample-10s.srt', fixture('sample-10s.srt'));
    await getDb().update(users).set({ storageUsedBytes: 524_288_000 - 1000 }).where(eq(users.id, user.id));
    const e = await (await estimate(file.id, { timing: TIMED })).json();
    expect(e.quotaOk).toBe(false);
    expect(e.needBytes).toBeGreaterThan(0);
  });

  it('timed với tệp không có mốc → 409 NO_TIMECODES; body có trường lạ → 422', async () => {
    const { file } = await setup('a.txt', 'Một câu.');
    const res = await estimate(file.id, { timing: TIMED });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('NO_TIMECODES');
    expect((await estimate(file.id, { whatever: 1 })).status).toBe(422);
    expect((await estimate(file.id, { timing: { mode: 'x' } })).status).toBe(422);
  });

  it('chưa đăng nhập → 401; tệp của người khác → 404; không gọi nhà cung cấp', async () => {
    const { file } = await setup('sample-10s.srt', fixture('sample-10s.srt'));
    expect((await new TestClient().post(`/api/files/${file.id}/estimate`, { json: {} })).status).toBe(401);
    const other = await createUser({ name: 'Người lạ' });
    expect((await estimate(file.id, {}, other)).status).toBe(404);
    expect(mock.requests.filter((r) => r.method === 'POST')).toHaveLength(0);
  });
});
