import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMockProvider, type MockProvider } from '../../mock-provider/server';
import { expect, test } from './fixtures';
import { e2eQuery, hdr, jobRow, makeVideoFile, openVideoTab, startUpload, videoJobs, videoProject, waitVideoJob } from './video-helpers';

/** Spec 006, US9 (T130 / quickstart §7): lấy âm thanh trên trình duyệt và chuyển về luồng máy chủ trong im lặng. */
let mock: MockProvider;
test.beforeAll(async () => {
  mock = await startMockProvider();
});
test.afterAll(async () => {
  await mock.close();
});

function makeShortM4a(seconds: number): Buffer {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'e2e-ca-'));
  try {
    const file = path.join(dir, 'short.m4a');
    execFileSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=500:duration=${seconds}`, '-c:a', 'aac', '-y', file]);
    return readFileSync(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('Chrome máy đủ mạnh: có phụ đề trước khi video tải xong, sửa được, nút xuất khóa kèm tiến độ (quickstart §7)', async ({ page }) => {
  test.setTimeout(180_000);
  const p = await videoProject(page, mock);
  await openVideoTab(page, p.id);

  // Giữ phần 2 của video nguồn lại để mô phỏng đang tải tệp lớn; âm thanh trình duyệt chỉ có 1 phần nhỏ nên xong ngay
  const createdPromise = page.waitForResponse((r) => r.url().endsWith(`/api/projects/${p.id}/video/jobs`) && r.request().method() === 'POST');
  let hold = true;
  let holdResolve: (() => void) | null = null;
  let sourceUploadId = '';
  const held = new Promise<void>((r) => {
    holdResolve = r;
  });
  await page.route('**/api/video/uploads/*/parts/2', async (route) => {
    if (hold && (!sourceUploadId || route.request().url().includes(sourceUploadId))) await held;
    await route.continue().catch(() => undefined);
  });

  await startUpload(page, makeVideoFile('luong-nhanh.mp4', { padMb: 17 }));
  sourceUploadId = ((await (await createdPromise).json()) as { upload: { id: string } }).upload.id;

  // Chưa tải xong video nguồn (sourceState === uploading) nhưng đã dịch xong 3 cue
  await expect.poll(async () => {
    const res = await page.request.get(`/api/projects/${p.id}/video/jobs`);
    const list = (await res.json()) as Array<{ id: string; editable: boolean; cueCount: number; sourceState: string }>;
    return list[0] ? `${list[0].sourceState}:${list[0].editable}:${list[0].cueCount}` : '';
  }, { timeout: 60_000, intervals: [500] }).toBe('uploading:true:3');

  const jobId = (await videoJobs(page, p.id))[0]!.id;
  await jobRow(page, 'luong-nhanh.mp4').getByRole('link', { name: 'Mở' }).click();
  await expect(page.getByTestId('cue-row')).toHaveCount(3);
  await expect(page.getByTestId('video-source-progress')).toBeVisible();

  // Sửa phụ đề khi video nguồn đang tải
  const firstTarget = page.getByRole('textbox', { name: 'Bản dịch đoạn 1' });
  await firstTarget.click();
  await firstTarget.fill('Xin chào từ luồng nhanh.');
  await expect(page.getByTestId('save-status')).toHaveText('Đã lưu');

  // Chuyển sang Xuất video: nút xuất bị khóa khi nguồn chưa tải xong, vẫn tải .srt được
  await page.getByRole('tab', { name: 'Xuất video' }).click();
  await expect(page.getByRole('button', { name: 'Xuất video', exact: true })).toBeDisabled();
  await expect(page.getByTestId('video-live-upload')).toBeVisible();
  const srt = await page.request.get(`/api/video/jobs/${jobId}/subtitles?format=srt&content=target`);
  expect(srt.status()).toBe(200);
  expect(await srt.text()).toContain('Xin chào từ luồng nhanh.');

  // Cho phần 2 hoàn tất -> nguồn kiểm xong, mở khóa xuất video và chỉ có 1 bản ghi tính phí
  hold = false;
  holdResolve!();
  await expect.poll(async () => {
    const r = await page.request.get(`/api/video/jobs/${jobId}`, { headers: hdr });
    return ((await r.json()) as { sourceState: string }).sourceState;
  }, { timeout: 60_000, intervals: [500] }).toBe('ready');
  await expect(page.getByRole('button', { name: 'Xuất video', exact: true })).toBeEnabled({ timeout: 20_000 });

  const usage = await e2eQuery<{ n: string }>('select count(*) as n from usage_records where video_job_id = $1 and ok', [jobId]);
  expect(Number(usage[0]!.n)).toBe(1);
});

test('thiếu bộ nhớ, .avi và lỗi luồng nhanh: chuyển về máy chủ trong im lặng, một bản ghi tính phí (quickstart §7)', async ({ browser, page }) => {
  test.setTimeout(180_000);
  // 1) Tệp .avi và lỗi giữa chừng ở luồng nhanh (chặn POST /client-audio -> 500) trên trang hiện tại
  const p = await videoProject(page, mock);
  await openVideoTab(page, p.id);

  let clientAudioPostCount = 0;
  await page.route('**/api/video/jobs/*/client-audio', async (route) => {
    clientAudioPostCount++;
    await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'INTERNAL', message: 'Boom' } }) });
  });
  let skipCount = 0;
  await page.route('**/api/video/jobs/*/client-audio/skip', async (route) => {
    skipCount++;
    await route.continue();
  });

  // Upload .avi -> không gọi /client-audio và vẫn xong
  await startUpload(page, makeVideoFile('nguon.avi'));
  const aviJob = await waitVideoJob(page, p.id, 'review_ready', 90_000);
  expect(clientAudioPostCount).toBe(0);
  const aviUsage = await e2eQuery<{ n: string }>('select count(*) as n from usage_records where video_job_id = $1 and ok', [aviJob.id]);
  expect(Number(aviUsage[0]!.n)).toBe(1);

  // Upload .mp4 khi POST /client-audio lỗi -> gọi /skip trong im lặng, không hiện lỗi, máy chủ xử lý 1 bản ghi tính phí
  await startUpload(page, makeVideoFile('loi-nhanh.mp4'));
  await expect.poll(() => skipCount, { timeout: 30_000 }).toBe(1);
  await expect(page.getByRole('alert').filter({ hasText: /\S/ })).toHaveCount(0);
  const fallbackJob = await waitVideoJob(page, p.id, 'review_ready', 90_000);
  expect(fallbackJob.fileName).toBe('loi-nhanh.mp4');
  const fallbackUsage = await e2eQuery<{ n: string }>('select count(*) as n from usage_records where video_job_id = $1 and ok', [fallbackJob.id]);
  expect(Number(fallbackUsage[0]!.n)).toBe(1);

  // 2) Thiết bị giả lập deviceMemory = 2: không chạy luồng nhanh và vẫn hoàn tất qua máy chủ
  const lowCtx = await browser.newContext({ locale: 'vi-VN' });
  await lowCtx.addInitScript(() => {
    Object.defineProperty(navigator, 'deviceMemory', { value: 2, configurable: true });
  });
  const lowPage = await lowCtx.newPage();
  try {
    const lowProj = await videoProject(lowPage, mock);
    await openVideoTab(lowPage, lowProj.id);
    let clientCalled = false;
    await lowPage.route('**/api/video/jobs/*/client-audio', async (route) => {
      clientCalled = true;
      await route.continue();
    });
    await startUpload(lowPage, makeVideoFile('may-yeu.mp4'));
    const lowJob = await waitVideoJob(lowPage, lowProj.id, 'review_ready', 90_000);
    expect(clientCalled).toBe(false);
    const lowUsage = await e2eQuery<{ n: string }>('select count(*) as n from usage_records where video_job_id = $1 and ok', [lowJob.id]);
    expect(Number(lowUsage[0]!.n)).toBe(1);
  } finally {
    await lowCtx.close();
  }
});

test('âm thanh trình duyệt lệch thời lượng > 1 giây: hiện hộp xác nhận trước khi dịch lại (quickstart §7)', async ({ page }) => {
  test.setTimeout(180_000);
  const p = await videoProject(page, mock);
  // Tắt Worker trong luồng tải của trang trước khi mở tab để bài kiểm tự gửi bản .m4a ngắn hơn nguồn 4 giây qua luồng nhanh
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'deviceMemory', { value: 2, configurable: true });
  });
  await openVideoTab(page, p.id);

  const shortM4a = makeShortM4a(2);
  let hold = true;
  let holdResolve: (() => void) | null = null;
  const held = new Promise<void>((r) => {
    holdResolve = r;
  });
  let sourceUploadId = '';
  const createdPromise = page.waitForResponse((r) => r.url().endsWith(`/api/projects/${p.id}/video/jobs`) && r.request().method() === 'POST');
  await page.route('**/api/video/uploads/*/parts/2', async (route) => {
    if (hold && (!sourceUploadId || route.request().url().includes(sourceUploadId))) await held;
    await route.continue().catch(() => undefined);
  });

  // Chặn /skip để giả lập deviceMemory=2 không báo skip lên máy chủ trong lúc bài kiểm tự gửi .m4a 2 giây qua luồng nhanh
  await page.route('**/api/video/jobs/*/client-audio/skip', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }),
  );
  // Bắt yêu cầu POST tạo việc để đánh dấu clientAudio = true như trình duyệt mạnh
  await page.route(`**/api/projects/${p.id}/video/jobs`, async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    const raw = route.request().postDataJSON() as Record<string, unknown>;
    await route.continue({ postData: JSON.stringify({ ...raw, clientAudio: true }) });
  });

  await startUpload(page, makeVideoFile('lech-tieng.mp4', { seconds: 6, padMb: 17 }));
  const created = (await (await createdPromise).json()) as { job: { id: string }; upload: { id: string } };
  sourceUploadId = created.upload.id;

  // Gửi .m4a 2 giây qua API như luồng nhanh của trình duyệt
  const sha = await import('node:crypto').then((c) => c.createHash('sha256').update(shortM4a).digest('hex'));
  const fp = await import('../../src/lib/video/fingerprint').then((f) => f.fingerprintOf(shortM4a.length, async (a, b) => shortM4a.subarray(a, b)));
  const caRes = await page.request.post(`/api/video/jobs/${created.job.id}/client-audio`, {
    data: { size: shortM4a.length, fingerprint: fp, ext: 'm4a', mime: 'audio/mp4' },
    headers: hdr,
  });
  expect(caRes.ok(), await caRes.text()).toBeTruthy();
  const caUp = (await caRes.json()) as { id: string };
  const putRes = await page.request.put(`/api/video/uploads/${caUp.id}/parts/1`, {
    data: shortM4a,
    headers: { ...hdr, 'content-type': 'application/octet-stream', 'x-part-sha256': sha },
  });
  expect(putRes.status()).toBe(204);
  expect((await page.request.post(`/api/video/uploads/${caUp.id}/complete`, { headers: hdr })).ok()).toBeTruthy();

  await waitVideoJob(page, p.id, 'review_ready', 60_000);
  hold = false;
  holdResolve!();

  await expect.poll(async () => {
    const r = await page.request.get(`/api/video/jobs/${created.job.id}`, { headers: hdr });
    const j = (await r.json()) as { sourceState: string; audioMismatch: boolean };
    return `${j.sourceState}:${j.audioMismatch}`;
  }, { timeout: 60_000, intervals: [500] }).toBe('ready:true');

  await jobRow(page, 'lech-tieng.mp4').getByRole('link', { name: 'Mở' }).click();
  const dlg = page.getByRole('alertdialog');
  await expect(dlg).toContainText('Âm thanh không khớp với video nguồn');
  await expect(page.getByTestId('audio-mismatch-banner')).toBeVisible();
  await dlg.getByRole('button', { name: 'Dịch lại từ nguồn' }).click();

  await expect.poll(async () => {
    const [row] = await e2eQuery<{ status: string; cue_run: number; audio_mismatch: boolean }>(
      'select status, cue_run, audio_mismatch from video_jobs where id = $1',
      [created.job.id],
    );
    return row ? `${row.status}:${row.cue_run}:${row.audio_mismatch}` : '';
  }, { timeout: 60_000, intervals: [500] }).toBe('review_ready:2:false');
  await expect(page.getByTestId('audio-mismatch-banner')).toHaveCount(0);
  const usage = await e2eQuery<{ n: string }>('select count(*) as n from usage_records where video_job_id = $1 and ok', [created.job.id]);
  expect(Number(usage[0]!.n)).toBe(2);
});
