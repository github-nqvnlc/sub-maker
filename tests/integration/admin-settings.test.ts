import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { stopBoss } from '@/worker/queues';
import { TestClient, clearRateLimits, createAdmin, createUser, resetDb, type TestUser } from './helpers';
import { newProject, uploadScript } from './voice-helpers';

/** US8 — cài đặt hệ thống do Administrator chỉnh (FR-043..044): đọc/ghi, kiểm tra giá trị, có hiệu lực ngay. */
const GB = 1024 ** 3;
/** 13 cài đặt của dịch video (spec 006, data-model §4). */
const VIDEO_DEFAULTS = {
  userVideoQuotaBytes: 30 * GB,
  videoSystemCapBytes: 100 * GB,
  videoMaxBytes: 10 * GB,
  videoMaxMinutes: 180,
  videoMaxJobsPerUser: 1,
  maxConcurrentVideoRenders: 1,
  maxConcurrentVideoTranslations: 2,
  videoSourceRetainHours: 48,
  videoIdleRetainDays: 7,
  videoOutputRetainDays: 7,
  videoProviderMaxMinutes: 300,
  videoGlossaryMaxPairs: 200,
  videoGlossaryMaxChars: 8000,
};
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
      maxOverlayJobsPerUser: 2,
      maxConcurrentOverlayJobs: 1,
      overlayMaxMinutes: 60,
      overlayMaxMinutesTransparent: 10,
      segmentConcurrency: 3,
      timingMaxSlipMs: 500,
      timingMaxCompressPct: 125,
      timingPartMinutes: 10,
      timingMergeGapMs: 1000,
      rpmFptMarketplace: 0,
      rpmShopaikeyOpenai: 0,
      rpmShopaikeyMinimax: 0,
      ...VIDEO_DEFAULTS,
    });
  });

  it('ghi và đọc lại các khóa đặt mốc (spec 003) trong khoảng hợp lệ', async () => {
    const res = await put({ timingMaxSlipMs: 300, timingMaxCompressPct: 115, timingPartMinutes: 5, timingMergeGapMs: 800, rpmFptMarketplace: 20 });
    expect(res.status).toBe(200);
    expect(await get()).toMatchObject({ timingMaxSlipMs: 300, timingMaxCompressPct: 115, timingPartMinutes: 5, timingMergeGapMs: 800, rpmFptMarketplace: 20 });
    await put({ timingMaxSlipMs: 500, timingMaxCompressPct: 125, timingPartMinutes: 10, timingMergeGapMs: 1000, rpmFptMarketplace: 0 });
  });

  it('ghi và đọc lại các khóa video overlay (spec 005) trong khoảng hợp lệ', async () => {
    const on = { maxOverlayJobsPerUser: 20, maxConcurrentOverlayJobs: 10, overlayMaxMinutes: 180, overlayMaxMinutesTransparent: 60 };
    expect((await put(on)).status).toBe(200);
    expect(await get()).toMatchObject(on);
    await put({ maxOverlayJobsPerUser: 2, maxConcurrentOverlayJobs: 1, overlayMaxMinutes: 60, overlayMaxMinutesTransparent: 10 });
  });

  it('ghi và đọc lại các khóa dịch video (spec 006); đổi cùng lúc hai giới hạn thời lượng thì kiểm theo giá trị mới', async () => {
    const on = { userVideoQuotaBytes: GB, videoSystemCapBytes: 10 * 1024 * GB, videoMaxBytes: 100 * 1024 * 1024, videoMaxMinutes: 400, videoProviderMaxMinutes: 400, videoMaxJobsPerUser: 10, maxConcurrentVideoRenders: 4, maxConcurrentVideoTranslations: 10, videoSourceRetainHours: 1, videoIdleRetainDays: 90, videoOutputRetainDays: 1, videoGlossaryMaxPairs: 1, videoGlossaryMaxChars: 10_000 };
    expect((await put(on)).status).toBe(200);
    expect(await get()).toMatchObject(on);
    expect((await put(VIDEO_DEFAULTS)).status).toBe(200);
    expect(await get()).toMatchObject(VIDEO_DEFAULTS);
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
    ['số tiến trình overlay mỗi người trên 20', { maxOverlayJobsPerUser: 21 }],
    ['số video overlay cùng lúc trên 10', { maxConcurrentOverlayJobs: 11 }],
    ['số video overlay cùng lúc bằng 0', { maxConcurrentOverlayJobs: 0 }],
    ['thời lượng overlay trên 180 phút', { overlayMaxMinutes: 181 }],
    ['thời lượng overlay trong suốt trên 60 phút', { overlayMaxMinutesTransparent: 61 }],
    ['rpm âm', { rpmFptMarketplace: -1 }],
    ['rpm trên 600', { rpmShopaikeyMinimax: 601 }],
    ['hạn mức video dưới 1 GB', { userVideoQuotaBytes: GB - 1 }],
    ['hạn mức video trên 1 TB', { userVideoQuotaBytes: 1024 * GB + 1 }],
    ['trần video hệ thống trên 10 TB', { videoSystemCapBytes: 10 * 1024 * GB + 1 }],
    ['video tối đa dưới 100 MB', { videoMaxBytes: 100 * 1024 * 1024 - 1 }],
    ['video tối đa trên 10 GB', { videoMaxBytes: 10 * GB + 1 }],
    ['thời lượng video 0 phút', { videoMaxMinutes: 0 }],
    ['thời lượng video vượt giới hạn nhà cung cấp', { videoMaxMinutes: 301 }],
    ['giới hạn nhà cung cấp thấp hơn thời lượng tối đa', { videoProviderMaxMinutes: 100 }],
    ['11 việc video mỗi người', { videoMaxJobsPerUser: 11 }],
    ['5 bản xuất video cùng lúc', { maxConcurrentVideoRenders: 5 }],
    ['11 lượt dịch cùng lúc', { maxConcurrentVideoTranslations: 11 }],
    ['giữ nguồn 721 giờ', { videoSourceRetainHours: 721 }],
    ['giữ video không hoạt động 91 ngày', { videoIdleRetainDays: 91 }],
    ['giữ thành phẩm 0 ngày', { videoOutputRetainDays: 0 }],
    ['giới hạn nhà cung cấp trên 1000 phút', { videoProviderMaxMinutes: 1001 }],
    ['từ điển 1001 cặp', { videoGlossaryMaxPairs: 1001 }],
    ['từ điển 499 ký tự', { videoGlossaryMaxChars: 499 }],
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
