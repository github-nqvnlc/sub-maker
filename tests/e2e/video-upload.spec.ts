import type { Route } from '@playwright/test';
import { startMockProvider, type MockProvider } from '../../mock-provider/server';
import { expect, test } from './fixtures';
import { expectNoHorizontalScroll } from './overlay-helpers';
import { adminSettings, chooseVideo, e2eQuery, jobRow, makeVideoFile, openVideoTab, PICK_LABEL, startUpload, videoJobs, videoProject, waitVideoJob } from './video-helpers';

/** Spec 006, US1 qua ĐƯỜNG THẬT: web, worker và ffmpeg; Soniox giả. */
let mock: MockProvider;

test.beforeAll(async () => {
  mock = await startMockProvider();
});
test.afterAll(async () => {
  await mock.close();
});

const PARTS = '**/api/video/uploads/*/parts/*';
const delayParts = (ms: number) => async (route: Route) => {
  await new Promise((r) => setTimeout(r, ms));
  await route.continue().catch(() => undefined); // yêu cầu đã bị hủy (tạm dừng)
};

test('tải video → dịch → chờ duyệt → nhật ký → xóa @mobile', async ({ page }) => {
  const p = await videoProject(page, mock);
  await openVideoTab(page, p.id);
  // ghi chú gửi âm thanh cho nhà cung cấp hiện trước lần dùng đầu (FR-058)
  await expect(page.getByText('được gửi cho nhà cung cấp bên ngoài')).toBeVisible();
  await expect(page.getByText('Chưa có việc dịch video nào')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Tải lên và dịch' })).toBeDisabled();
  await expectNoHorizontalScroll(page);

  await chooseVideo(page, { name: 'sai.gif', mimeType: 'image/gif', buffer: Buffer.from('GIF89a') });
  await expect(page.getByRole('alert').filter({ hasText: 'Định dạng không được hỗ trợ' })).toBeVisible();

  await startUpload(page, makeVideoFile('phim-e2e.mp4'));
  const row = jobRow(page, 'phim-e2e.mp4');
  await expect(row.getByText('Chờ duyệt')).toBeVisible({ timeout: 60_000 });
  await expect(row.getByText('3 đoạn phụ đề')).toBeVisible();
  await expect(row.getByText('50%')).toBeVisible();
  await expect(page.getByRole('tab', { name: /Dịch Video \(1\)/ })).toBeVisible();
  await expectNoHorizontalScroll(page);

  await row.getByRole('button', { name: 'Nhật ký' }).click();
  const log = page.getByRole('dialog').getByRole('log');
  await expect(log).toContainText('Đã tạo 3 đoạn phụ đề, chờ duyệt');
  await expect(log).toContainText('Video 640×360');
  await page.keyboard.press('Escape');

  await row.getByRole('button', { name: 'Xóa: phim-e2e.mp4' }).click();
  const confirm = page.getByRole('alertdialog');
  await expect(confirm).toContainText('1 việc dịch, trả lại');
  await expect(confirm).toContainText('bị xóa vĩnh viễn');
  await confirm.getByRole('button', { name: 'Xóa' }).click();
  await expect(page.getByText('Chưa có việc dịch video nào')).toBeVisible();
  expect(await videoJobs(page, p.id)).toEqual([]);
});

test('tạm dừng, tiếp tục và mạng đứt rồi có lại', async ({ page }) => {
  const p = await videoProject(page, mock);
  await openVideoTab(page, p.id);
  await page.route(PARTS, delayParts(2500));
  await startUpload(page, makeVideoFile('hai-phan.mp4', { padMb: 17 }));
  const live = page.getByTestId('video-live-upload');
  await expect(live).toContainText('Đang tải lên');
  await live.getByRole('button', { name: 'Tạm dừng' }).click();
  await expect(live).toContainText('Đã tạm dừng');
  await expect(jobRow(page, 'hai-phan.mp4').getByText('Đang tải lên')).toBeVisible();

  // mạng đứt: hai lần gửi đầu của mỗi phần thất bại, bộ tải tự thử lại
  await page.unroute(PARTS);
  const attempts = new Map<string, number>();
  await page.route(PARTS, async (route) => {
    const n = (attempts.get(route.request().url()) ?? 0) + 1;
    attempts.set(route.request().url(), n);
    if (n <= 2) await route.abort('internetdisconnected');
    else await route.continue();
  });
  await live.getByRole('button', { name: 'Tiếp tục' }).click();
  await waitVideoJob(page, p.id, 'review_ready');
  expect([...attempts.values()]).toEqual([3, 3]);
  await expect(jobRow(page, 'hai-phan.mp4').getByText('Chờ duyệt')).toBeVisible();
  await expect(live).toBeHidden();
});

test('đóng trang khi mới tải một phần rồi chọn lại đúng tệp; tệp khác được hỏi tạo việc mới', async ({ page }) => {
  const p = await videoProject(page, mock);
  await openVideoTab(page, p.id);
  // phần 2 treo mãi: chỉ phần 1 tới máy chủ
  await page.route(PARTS, async (route) => {
    if (route.request().url().endsWith('/parts/1')) await route.continue();
  });
  const file = makeVideoFile('tai-do.mp4', { padMb: 17 });
  await startUpload(page, file);
  await expect.poll(async () => (await videoJobs(page, p.id))[0] && (await (await page.request.get(`/api/projects/${p.id}/video/jobs`)).json())[0].upload?.receivedBytes).toBe(16 * 1024 * 1024);

  await page.unroute(PARTS);
  await page.reload();
  await page.getByRole('tab', { name: /Dịch Video/ }).click();
  await expect(page.getByRole('heading', { name: 'Video đang tải dở' })).toBeVisible();
  await expect(page.getByText(/Chọn lại đúng tệp "tai-do\.mp4"/)).toBeVisible();

  const resumeLabel = 'Chọn lại tệp để tải tiếp: tai-do.mp4';
  await chooseVideo(page, makeVideoFile('khac.mp4', { seconds: 3 }), resumeLabel);
  const ask = page.getByRole('alertdialog');
  await expect(ask).toContainText('Tệp khác với video đang tải dở');
  await ask.getByRole('button', { name: 'Hủy' }).click();

  const sent: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'PUT' && r.url().includes('/parts/')) sent.push(r.url().split('/').at(-1)!);
  });
  await chooseVideo(page, file, resumeLabel);
  await waitVideoJob(page, p.id, 'review_ready');
  expect(sent).toEqual(['2']);
});

test('chưa được cấp quyền: thấy cách xin quyền, không tạo được việc @mobile', async ({ page }) => {
  const p = await videoProject(page, mock, { allowed: false });
  await openVideoTab(page, p.id);
  await expect(page.getByText('Bạn chưa được cấp quyền Dịch Video')).toBeVisible();
  await expect(page.getByText('liên hệ quản trị viên để được bật quyền')).toBeVisible();
  await expect(page.locator(`input[type=file][aria-label="${PICK_LABEL}"]`)).toHaveCount(0);
  const denied = await page.request.post(`/api/projects/${p.id}/video/jobs`, {
    data: { fileName: 'a.mp4', size: 10, fingerprint: 'a'.repeat(64), direction: 'to_vi' },
    headers: { Origin: new URL(page.url()).origin },
  });
  expect(denied.status()).toBe(403);
  await expectNoHorizontalScroll(page);
});

test('Independent Test US1: video 5 phút, ngắt mạng rồi tiếp tục, nhận kịch bản song ngữ; các trường hợp bị từ chối', async ({ page }) => {
  test.setTimeout(240_000);
  const p = await videoProject(page, mock);
  await openVideoTab(page, p.id);
  const film = makeVideoFile('phim-5-phut.mp4', { seconds: 300, size: '160x90', rate: 10, padMb: 33 });

  let drop = true;
  await page.route(PARTS, async (route) => {
    if (drop) await route.abort('internetdisconnected');
    else await delayParts(300)(route);
  });
  await startUpload(page, film);
  const live = page.getByTestId('video-live-upload');
  await expect(live).toContainText(/Đang tải lên|Đã tạm dừng/);

  // đang có một việc chạy: tạo việc thứ hai bị từ chối đúng lý do
  await startUpload(page, makeVideoFile('thu-hai.mp4', { seconds: 2 }));
  await expect(page.getByRole('alert').filter({ hasText: 'đủ số việc video đang chạy' })).toBeVisible();

  // thử hết 1+2+4+8+16 giây thì tạm dừng, báo mất kết nối
  await expect(live).toContainText('Đã tạm dừng', { timeout: 60_000 });
  await expect(live.getByRole('alert')).toContainText('Mất kết nối');
  drop = false;
  await live.getByRole('button', { name: 'Tiếp tục' }).click();
  const job = await waitVideoJob(page, p.id, 'review_ready', 120_000);
  expect(job.cueCount).toBe(3);

  const cues = await e2eQuery<{ start_ms: number; end_ms: number; source_text: string; target_text: string; timing: string }>(
    'select start_ms, end_ms, source_text, target_text, timing from video_cues where job_id = $1 order by start_ms',
    [job.id],
  );
  expect(cues.map((c) => [c.source_text, c.target_text])).toEqual([
    ['Hello everyone.', 'Xin chào mọi người.'],
    ['Today we learn something new.', 'Hôm nay chúng ta học điều mới.'],
    ['Thank you, teacher.', 'Cảm ơn thầy.'],
  ]);
  expect(cues[0]).toMatchObject({ start_ms: 120, timing: 'measured' });
  const usage = await e2eQuery<{ n: string }>('select count(*) as n from usage_records where video_job_id = $1 and ok', [job.id]);
  expect(Number(usage[0]!.n)).toBe(1);

  // video quá thời lượng cho phép bị từ chối đúng lý do, không phát sinh phí
  await adminSettings(page, { videoMaxMinutes: 1 });
  try {
    const again = await videoProject(page, mock);
    await openVideoTab(page, again.id);
    await startUpload(page, makeVideoFile('qua-dai.mp4', { seconds: 70, size: '160x90', rate: 5 }));
    const row = jobRow(page, 'qua-dai.mp4');
    await expect(row.getByText('Lỗi', { exact: true })).toBeVisible({ timeout: 60_000 });
    await expect(row.getByRole('alert')).toContainText('Video dài hơn mức cho phép');
  } finally {
    await adminSettings(page, { videoMaxMinutes: 180 });
  }
});
