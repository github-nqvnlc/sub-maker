import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startMockProvider, type MockProvider } from '../../mock-provider/server';
import { getDb } from '@/lib/db';
import { projects, usageRecords, users } from '@/lib/db/schema';
import { runGenerateVoice } from '@/worker/jobs/generate-voice';
import { deleteUserData } from '@/worker/jobs/delete-user';
import { stopBoss } from '@/worker/queues';
import { TestClient, clearRateLimits, createAdmin, createUser, resetDb, type TestUser } from './helpers';
import { FAST, SCRIPT_4, newProject, putGlobalConfig, startJob, uploadScript } from './voice-helpers';

/** US8 — Dashboard cá nhân và thống kê Administrator (FR-038..040). */
let mock: MockProvider;
let admin: TestUser;
let alice: TestUser;
let bob: TestUser;

type Dash = {
  projects: number;
  voices: number;
  totalDurationMs: number;
  jobsByStatus: Record<string, number>;
  usage: { chars: number; tokens: number | null; costEstimateUsd: number | null; byDay: { date: string; chars: number }[]; byProvider: { providerType: string; configScope: string; chars: number }[] };
  storageUsedBytes: number;
  storageQuotaBytes: number;
};
type Stats = {
  totals: { users: number; projects: number; voices: number; chars: number; tokens: number | null; costEstimateUsd: number | null; charsByScope: { global: number; user: number } };
  users: { user: { id: string; email: string }; projects: number; voices: number; chars: number; costEstimateUsd: number | null }[];
};

const dash = async (u: TestUser, qs = '') => (await (await u.client.get(`/api/dashboard${qs}`)).json()) as Dash;
const stats = async (qs = '') => (await (await admin.client.get(`/api/admin/stats${qs}`)).json()) as Stats;
const sentChars = SCRIPT_4.split('\n').reduce((n, l) => n + [...l].length, 0);

beforeAll(async () => {
  mock = await startMockProvider();
  await resetDb();
  admin = await createAdmin();
  await putGlobalConfig(admin, mock, 'ok', { pricePerMillionChars: 1_000_000 }); // 1 USD / 1 triệu ký tự → chi phí = số ký tự
  alice = await createUser({ name: 'Alice' });
  bob = await createUser({ name: 'Bob' });
});
afterAll(async () => {
  await mock.close();
  await stopBoss();
});
beforeEach(clearRateLimits); // các test gọi nhiều API liên tiếp

describe('Dashboard cá nhân', () => {
  it('User mới chưa có dữ liệu: toàn số 0, tokens/chi phí là null (không bịa số)', async () => {
    const d = await dash(alice);
    expect(d).toMatchObject({ projects: 0, voices: 0, totalDurationMs: 0, jobsByStatus: {} });
    expect(d.usage).toMatchObject({ chars: 0, tokens: null, costEstimateUsd: null, byDay: [], byProvider: [] });
    expect(d.storageQuotaBytes).toBe(524_288_000);
  });

  it('số Project/voice/thời lượng/trạng thái/ký tự khớp sau khi tạo voice; dùng lại cache không tính thêm', async () => {
    const projectId = await newProject(alice);
    const file = await uploadScript(alice, projectId, SCRIPT_4);
    const job = await startJob(alice, projectId, file.id);
    await runGenerateVoice(job.id, FAST);

    let d = await dash(alice);
    expect(d.projects).toBe(1);
    expect(d.voices).toBe(1);
    expect(d.totalDurationMs).toBeGreaterThan(1000);
    expect(d.jobsByStatus).toEqual({ completed: 1 });
    expect(d.usage.chars).toBe(sentChars);
    expect(d.usage.tokens).toBeNull(); // TTS không trả token
    expect(d.usage.costEstimateUsd).toBeCloseTo(sentChars, 6);
    expect(d.usage.byDay).toHaveLength(1);
    expect(d.usage.byDay[0]!.chars).toBe(sentChars);
    expect(d.usage.byProvider).toEqual([{ providerType: 'fpt_marketplace', configScope: 'global', chars: sentChars }]);
    expect(d.storageUsedBytes).toBeGreaterThan(0);

    // chạy lại cùng kịch bản + thiết lập: mọi đoạn lấy từ cache → KHÔNG có lần gọi nhà cung cấp mới
    const again = await alice.client.post(`/api/jobs/${job.id}/rerun`, { json: {} });
    expect(again.status).toBe(202);
    const job2 = (await again.json()) as { id: string };
    await runGenerateVoice(job2.id, FAST);
    d = await dash(alice);
    expect(d.voices).toBe(2);
    expect(d.jobsByStatus).toEqual({ completed: 2 });
    expect(d.usage.chars).toBe(sentChars); // không đổi
  });

  it('bản ghi lỗi (ok=false) và bản ghi ngoài khoảng ngày không được cộng; chọn khoảng rộng hơn thì thấy', async () => {
    const [proj] = await getDb().select().from(projects).where(eq(projects.ownerId, alice.id));
    const base = { userId: alice.id, projectId: proj!.id, providerType: 'fpt_marketplace' as const, configScope: 'global' as const };
    await getDb().insert(usageRecords).values({ ...base, unitsChars: 999, ok: false });
    const old = new Date(Date.now() - 90 * 86_400_000);
    await getDb().insert(usageRecords).values({ ...base, unitsChars: 5000, ok: true, ts: old, costEstimateUsd: 0.5 });

    expect((await dash(alice)).usage.chars).toBe(sentChars);

    const day = (d: Date) => d.toISOString().slice(0, 10);
    const wide = await dash(alice, `?from=${day(new Date(Date.now() - 100 * 86_400_000))}&to=${day(new Date())}`);
    expect(wide.usage.chars).toBe(sentChars + 5000);
    expect(wide.usage.byDay.length).toBeGreaterThanOrEqual(2);
  });

  it('khoảng ngày sai → 422', async () => {
    expect((await alice.client.get('/api/dashboard?from=2026-02-01&to=2026-01-01')).status).toBe(422);
    expect((await alice.client.get('/api/dashboard?from=hôm-qua')).status).toBe(422);
    expect((await alice.client.get('/api/dashboard?from=2020-01-01&to=2026-01-01')).status).toBe(422); // quá 366 ngày
  });

  it('chưa đăng nhập → 401; mỗi User chỉ thấy số liệu của mình', async () => {
    expect((await new TestClient().get('/api/dashboard')).status).toBe(401);
    const b = await dash(bob);
    expect(b.projects).toBe(0);
    expect(b.usage.chars).toBe(0);
  });
});

describe('Thống kê Administrator', () => {
  it('User thường → 404, chưa đăng nhập → 401', async () => {
    expect((await alice.client.get('/api/admin/stats')).status).toBe(404);
    expect((await new TestClient().get('/api/admin/stats')).status).toBe(401);
  });

  it('tách chung/riêng, từng User, chi phí NULL khi không có giá, sắp xếp theo tiêu chí', async () => {
    const [bobProject] = await getDb()
      .insert(projects)
      .values({ ownerId: bob.id, name: 'Dự án của Bob', providerType: 'shopaikey_openai' })
      .returning();
    await getDb().insert(usageRecords).values({
      userId: bob.id,
      projectId: bobProject!.id,
      providerType: 'shopaikey_openai',
      configScope: 'user', // Bob dùng khóa riêng
      unitsChars: 700,
      ok: true,
    });

    const s = await stats();
    expect(s.totals.users).toBe(3); // admin + alice + bob
    expect(s.totals.chars).toBe(sentChars + 700);
    expect(s.totals.charsByScope).toEqual({ global: sentChars, user: 700 });
    expect(s.totals.costEstimateUsd).toBeCloseTo(sentChars, 6); // chỉ cộng bản ghi có giá

    const a = s.users.find((x) => x.user.id === alice.id)!;
    const b = s.users.find((x) => x.user.id === bob.id)!;
    expect(a).toMatchObject({ projects: 1, voices: 2, chars: sentChars });
    expect(b).toMatchObject({ projects: 1, voices: 0, chars: 700, costEstimateUsd: null });

    // sắp xếp theo ký tự (mặc định giảm dần): Bob 700 > Alice? sentChars > 700 nên Alice trước
    const order = (r: Stats) => r.users.filter((x) => [alice.id, bob.id].includes(x.user.id)).map((x) => x.user.id);
    const byChars = sentChars > 700 ? [alice.id, bob.id] : [bob.id, alice.id];
    expect(order(await stats('?sort=chars&order=desc'))).toEqual(byChars);
    expect(order(await stats('?sort=chars&order=asc'))).toEqual([...byChars].reverse());
    expect(order(await stats('?sort=voices&order=desc'))[0]).toBe(alice.id);
    expect((await admin.client.get('/api/admin/stats?sort=lol')).status).toBe(422);
  });

  it('xóa User: thống kê ẩn danh vẫn nằm trong tổng, nhưng User biến mất khỏi bảng', async () => {
    const before = await stats();
    await getDb().update(users).set({ status: 'deleting' }).where(eq(users.id, bob.id));
    await deleteUserData(bob.id);
    await getDb().delete(users).where(eq(users.id, bob.id));

    const after = await stats();
    expect(after.users.some((x) => x.user.id === bob.id)).toBe(false);
    expect(after.totals.users).toBe(before.totals.users - 1);
    expect(after.totals.chars).toBe(before.totals.chars); // 700 ký tự ẩn danh vẫn còn
    expect(after.totals.charsByScope.user).toBe(700);
  });
});
