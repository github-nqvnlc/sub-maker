import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { stopBoss } from '@/worker/queues';
import { TestClient, clearRateLimits, createAdmin, createUser, resetDb, type TestUser } from './helpers';
import { newProject, uploadScript } from './voice-helpers';

/** US8 — cài đặt hệ thống do Administrator chỉnh (FR-043..044): đọc/ghi, kiểm tra giá trị, có hiệu lực ngay. */
let admin: TestUser;
let user: TestUser;

beforeAll(async () => {
  await resetDb();
  admin = await createAdmin();
  user = await createUser();
});
afterAll(async () => {
  await stopBoss();
});
beforeEach(clearRateLimits);

const get = async () => (await (await admin.client.get('/api/admin/settings')).json()) as Record<string, number>;
const put = (json: unknown) => admin.client.put('/api/admin/settings', { json });

describe('/api/admin/settings', () => {
  it('chưa đăng nhập → 401; User thường → 404 (cả đọc lẫn ghi)', async () => {
    expect((await new TestClient().get('/api/admin/settings')).status).toBe(401);
    expect((await user.client.get('/api/admin/settings')).status).toBe(404);
    expect((await user.client.put('/api/admin/settings', { json: { maxFileBytes: 1_000_000 } })).status).toBe(404);
  });

  it('đọc giá trị mặc định', async () => {
    expect(await get()).toEqual({
      maxFileBytes: 2_097_152,
      userQuotaBytes: 524_288_000,
      maxConcurrentJobs: 3,
      maxJobsPerUser: 2,
      maxSttJobsPerUser: 2,
      segmentConcurrency: 3,
      timingMaxSlipMs: 500,
      timingMaxCompressPct: 125,
      timingPartMinutes: 10,
      timingMergeGapMs: 1000,
      rpmFptMarketplace: 0,
      rpmShopaikeyOpenai: 0,
      rpmShopaikeyMinimax: 0,
    });
  });

  it('ghi và đọc lại các khóa đặt mốc (spec 003) trong khoảng hợp lệ', async () => {
    const res = await put({ timingMaxSlipMs: 300, timingMaxCompressPct: 115, timingPartMinutes: 5, timingMergeGapMs: 800, rpmFptMarketplace: 20 });
    expect(res.status).toBe(200);
    expect(await get()).toMatchObject({ timingMaxSlipMs: 300, timingMaxCompressPct: 115, timingPartMinutes: 5, timingMergeGapMs: 800, rpmFptMarketplace: 20 });
    await put({ timingMaxSlipMs: 500, timingMaxCompressPct: 125, timingPartMinutes: 10, timingMergeGapMs: 1000, rpmFptMarketplace: 0 });
  });

  it('ghi từng phần và đọc lại đúng', async () => {
    const res = await put({ maxConcurrentJobs: 5, maxJobsPerUser: 4, segmentConcurrency: 6 });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ maxConcurrentJobs: 5, maxJobsPerUser: 4, segmentConcurrency: 6, maxFileBytes: 2_097_152 });
    expect(await get()).toMatchObject({ maxConcurrentJobs: 5, maxJobsPerUser: 4, segmentConcurrency: 6 });
    await put({ maxConcurrentJobs: 3, maxJobsPerUser: 2, segmentConcurrency: 3 });
  });

  it.each([
    ['không', { maxFileBytes: 0 }],
    ['âm', { maxConcurrentJobs: -1 }],
    ['không nguyên', { maxJobsPerUser: 1.5 }],
    ['là chuỗi', { segmentConcurrency: '3' }],
    ['quá lớn', { segmentConcurrency: 1000 }],
    ['khóa lạ', { somethingElse: 1 }],
    ['quota nhỏ hơn 1 MB', { userQuotaBytes: 10 }],
    ['độ trễ tối đa dưới 100 ms', { timingMaxSlipMs: 50 }],
    ['độ trễ tối đa trên 2000 ms', { timingMaxSlipMs: 2001 }],
    ['mức nén dưới 100%', { timingMaxCompressPct: 99 }],
    ['mức nén trên 150%', { timingMaxCompressPct: 151 }],
    ['cửa sổ phần 0 phút', { timingPartMinutes: 0 }],
    ['cửa sổ phần 31 phút', { timingPartMinutes: 31 }],
    ['khoảng nghỉ ghép dưới 200 ms', { timingMergeGapMs: 100 }],
    ['rpm âm', { rpmFptMarketplace: -1 }],
    ['rpm trên 600', { rpmShopaikeyMinimax: 601 }],
  ])('giá trị %s → 422 và không thay đổi gì', async (_name, body) => {
    const before = await get();
    expect((await put(body)).status).toBe(422);
    expect(await get()).toEqual(before);
  });

  it('đổi maxFileBytes có hiệu lực ngay cho lần tải kế tiếp', async () => {
    const projectId = await newProject(user);
    const big = 'Một câu khá dài để vượt giới hạn nhỏ. '.repeat(100); // ~3,8 KB
    await uploadScript(user, projectId, big, 'a.txt'); // mặc định 2 MB: được

    expect((await put({ maxFileBytes: 2048 })).status).toBe(200);
    const form = new FormData();
    form.set('file', new File([big], 'b.txt', { type: 'text/plain' }));
    const res = await user.client.post(`/api/projects/${projectId}/files`, { form });
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('FILE_TOO_LARGE');

    await put({ maxFileBytes: 2_097_152 });
    await uploadScript(user, projectId, big, 'c.txt'); // trả về mặc định: được lại
  });

  it('đổi hạn mức lưu trữ áp dụng ngay: vượt hạn mức → 409 QUOTA_EXCEEDED', async () => {
    const quotaUser = await createUser();
    const projectId = await newProject(quotaUser);
    const filler = 'Nội dung kịch bản để chiếm dung lượng lưu trữ. '.repeat(400); // ~18 KB
    const used = new TextEncoder().encode(filler).length;
    expect((await put({ userQuotaBytes: 1024 * 1024 })).status).toBe(200);

    // đủ chỗ cho vài lần tải rồi hết
    let rejected = false;
    for (let i = 0; i < Math.ceil((1024 * 1024) / used) + 2 && !rejected; i++) {
      const form = new FormData();
      form.set('file', new File([filler + String(i)], `f${i}.txt`, { type: 'text/plain' }));
      const res = await quotaUser.client.post(`/api/projects/${projectId}/files`, { form });
      if (res.status === 409) {
        expect(((await res.json()) as { error: { code: string } }).error.code).toBe('QUOTA_EXCEEDED');
        rejected = true;
      } else expect(res.status).toBe(201);
    }
    expect(rejected).toBe(true);
    await put({ userQuotaBytes: 524_288_000 });
  });
});
