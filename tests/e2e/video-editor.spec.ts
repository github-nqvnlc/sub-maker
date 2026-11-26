import type { Page } from '@playwright/test';
import { startMockProvider, type MockProvider } from '../../mock-provider/server';
import { expect, test } from './fixtures';
import { expectNoHorizontalScroll } from './overlay-helpers';
import { e2eQuery, jobRow, makeVideoFile, openVideoTab, startUpload, videoProject, waitVideoJob } from './video-helpers';

/** Spec 006, US2 qua đường thật: trình phát đồng bộ, sửa, tự lưu, hoàn tác, hai thẻ trình duyệt (FR-022, FR-023, FR-024). */
let mock: MockProvider;

test.beforeAll(async () => {
  mock = await startMockProvider();
});
test.afterAll(async () => {
  await mock.close();
});

// Soniox giả: ba cue ở 120–1180, 1800–3680, 4500–5780 ms; video dài 6 giây
async function openEditor(page: Page, fileName = 'bien-tap.webm') {
  const p = await videoProject(page, mock);
  await openVideoTab(page, p.id);
  await startUpload(page, makeVideoFile(fileName));
  const job = await waitVideoJob(page, p.id, 'review_ready');
  await jobRow(page, fileName).getByRole('link', { name: 'Mở' }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${p.id}/video/${job.id}`));
  await expect(page.getByRole('heading', { level: 1, name: fileName })).toBeVisible();
  await expect(rows(page)).toHaveCount(3);
  await expect(canvas(page)).toHaveAttribute('data-fonts', 'ready');
  return { projectId: p.id, jobId: job.id };
}

const rows = (page: Page) => page.getByTestId('cue-row');
const row = (page: Page, n: number) => rows(page).nth(n - 1);
const target = (page: Page, n: number) => page.getByRole('textbox', { name: `Bản dịch đoạn ${n}`, exact: true });
const source = (page: Page, n: number) => page.getByRole('textbox', { name: `Câu gốc đoạn ${n}`, exact: true });
const startOf = (page: Page, n: number) => page.getByRole('textbox', { name: `Mốc bắt đầu đoạn ${n}` });
const endOf = (page: Page, n: number) => page.getByRole('textbox', { name: `Mốc kết thúc đoạn ${n}` });
const media = (page: Page) => page.getByTestId('video-preview-media');
const canvas = (page: Page) => page.getByTestId('video-preview-canvas');
const saved = (page: Page) => expect(page.getByTestId('save-status')).toHaveText('Đã lưu', { timeout: 10_000 });

const cuesInDb = (jobId: string) =>
  e2eQuery<{ start_ms: number; end_ms: number; source_text: string; target_text: string; timing: string }>('select start_ms, end_ms, source_text, target_text, timing from video_cues where job_id = $1 order by start_ms', [jobId]);

/** Tua tới mốc (giây) và chờ khung đã vẽ. */
async function seekTo(page: Page, seconds: number) {
  await media(page).evaluate(async (el, at) => {
    const v = el as HTMLVideoElement;
    v.pause();
    await new Promise<void>((resolve) => {
      v.addEventListener('seeked', () => resolve(), { once: true });
      v.currentTime = at;
    });
    await new Promise((r) => setTimeout(r, 100));
  }, seconds);
}
/** Số điểm ảnh có chữ trên lớp phụ đề. */
const inked = (page: Page) =>
  canvas(page).evaluate((el) => {
    const c = el as HTMLCanvasElement;
    const data = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i]! > 0) n++;
    return n;
  });

test('phát đồng bộ: chữ nổi đúng mốc, cue được tô sáng, bấm mốc thì phát từ đó @mobile', async ({ page }) => {
  await openEditor(page);
  await expect(media(page)).toHaveAttribute('data-kind', /local|source/);
  await expectNoHorizontalScroll(page);

  await seekTo(page, 0.6);
  await expect(row(page, 1)).toHaveAttribute('data-active', 'true');
  await expect.poll(() => inked(page)).toBeGreaterThan(100);
  await seekTo(page, 1.5); // khoảng trống giữa hai cue
  await expect(row(page, 1)).toHaveAttribute('data-active', 'false');
  await expect.poll(() => inked(page)).toBe(0);

  await page.getByRole('button', { name: 'Phát từ đoạn 2' }).click();
  await expect.poll(() => media(page).evaluate((el) => (el as HTMLVideoElement).currentTime)).toBeGreaterThanOrEqual(1.8);
  await expect(row(page, 2)).toHaveAttribute('data-active', 'true');
  await expect(row(page, 3)).toHaveAttribute('data-active', 'true', { timeout: 15_000 });
  await expectNoHorizontalScroll(page);
});

test('sửa chữ và mốc, tách, gộp, thêm, xóa, hoàn tác; tải lại trang vẫn còn nguyên @mobile', async ({ page }) => {
  const { projectId, jobId } = await openEditor(page);

  await target(page, 1).fill('Chào cả nhà.');
  await saved(page);
  await expect.poll(async () => (await cuesInDb(jobId))[0]!.target_text).toBe('Chào cả nhà.');

  // ±100 / ±500 ms, bị chặn ở cue liền trước
  await row(page, 2).click({ position: { x: 5, y: 5 } });
  await page.getByRole('button', { name: 'Mốc bắt đầu đoạn 2 −100 ms' }).click();
  await expect(startOf(page, 2)).toHaveValue('00:01.700');
  await page.getByRole('button', { name: 'Mốc bắt đầu đoạn 2 −500 ms' }).click();
  await page.getByRole('button', { name: 'Mốc bắt đầu đoạn 2 −500 ms' }).click();
  await expect(startOf(page, 2)).toHaveValue('00:01.180');
  await page.getByRole('button', { name: 'Hoàn tác' }).click();
  await expect(startOf(page, 2)).toHaveValue('00:01.200');
  await page.getByRole('button', { name: 'Làm lại' }).click();
  await expect(startOf(page, 2)).toHaveValue('00:01.180');

  // nhập số, sai dạng thì báo
  await endOf(page, 2).fill('abc');
  await endOf(page, 2).press('Enter');
  await expect(page.getByRole('alert').filter({ hasText: 'Mốc không hợp lệ' })).toBeVisible();
  await endOf(page, 2).fill('00:03.500');
  await endOf(page, 2).press('Enter');
  await expect(endOf(page, 2)).toHaveValue('00:03.500');

  // dòng thời gian dùng được bằng bàn phím
  await page.getByTestId('video-timeline').getByRole('slider', { name: 'Kéo mốc kết thúc' }).press('ArrowRight');
  await expect(endOf(page, 2)).toHaveValue('00:03.600');
  await saved(page);

  // tách tại con trỏ, gộp lại
  await target(page, 2).click();
  await target(page, 2).press('Control+Home');
  for (let i = 0; i < 'Hôm nay chúng ta'.length; i++) await target(page, 2).press('ArrowRight');
  await page.getByRole('button', { name: 'Tách', exact: true }).click();
  await expect(rows(page)).toHaveCount(4);
  await expect(target(page, 2)).toHaveValue('Hôm nay chúng ta');
  await expect(target(page, 3)).toHaveValue('học điều mới.');
  await expect(target(page, 3)).toBeFocused(); // tiêu điểm tới phần vừa tách, không rơi về đầu trang
  await row(page, 2).click({ position: { x: 5, y: 5 } });
  await page.getByRole('button', { name: 'Gộp với đoạn sau' }).click();
  await expect(rows(page)).toHaveCount(3);
  await expect(target(page, 2)).toHaveValue('Hôm nay chúng ta học điều mới.');

  // thêm sau cue cuối rồi xóa, có xác nhận
  await row(page, 3).click({ position: { x: 5, y: 5 } });
  await page.getByRole('button', { name: 'Thêm đoạn sau' }).click();
  await expect(rows(page)).toHaveCount(4);
  await expect(target(page, 4)).toBeFocused();
  await target(page, 4).fill('Hẹn gặp lại.');
  await row(page, 4).click({ position: { x: 5, y: 5 } });
  await page.getByRole('button', { name: 'Xóa đoạn 4' }).click();
  const confirm = page.getByRole('alertdialog');
  await expect(confirm).toContainText('1 đoạn phụ đề (đoạn 4)');
  await confirm.getByRole('button', { name: 'Xóa' }).click();
  await expect(rows(page)).toHaveCount(3);
  await page.getByRole('button', { name: 'Hoàn tác' }).click();
  await expect(target(page, 4)).toHaveValue('Hẹn gặp lại.');
  await saved(page);
  await expectNoHorizontalScroll(page);

  await page.reload();
  await expect(rows(page)).toHaveCount(4);
  await expect(target(page, 1)).toHaveValue('Chào cả nhà.');
  await expect(target(page, 4)).toHaveValue('Hẹn gặp lại.');
  await expect(source(page, 1)).toHaveValue('Hello everyone.');
  expect((await cuesInDb(jobId))[1]).toMatchObject({ start_ms: 1180, end_ms: 3600, timing: 'manual' });

  await page.getByRole('tab', { name: 'Nhật ký' }).click();
  await expect(page.getByRole('log')).toContainText('Đã tạo 3 đoạn phụ đề');
  await page.getByRole('link', { name: 'Về Project' }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}\\?tab=video`));
  await expect(page.getByRole('heading', { name: 'Dịch video và gắn phụ đề' })).toBeVisible();
});

test('hai thẻ cùng sửa: thẻ sau được báo tải lại, bản của thẻ trước không bị đè; video không phát được hình dùng bản xem trước', async ({ page, context }) => {
  // .avi MPEG-4: trình duyệt không phát được, máy chủ tạo bản xem trước
  const { jobId } = await openEditor(page, 'hai-the.avi');
  await expect(media(page)).toHaveAttribute('data-kind', 'preview', { timeout: 30_000 });
  await expect.poll(() => media(page).evaluate((el) => (el as HTMLVideoElement).videoWidth), { timeout: 15_000 }).toBeGreaterThan(0);

  const second = await context.newPage();
  await second.goto(page.url());
  await expect(second.getByTestId('cue-row')).toHaveCount(3);
  // giữ thẻ hai ở bản cũ (thẻ nhận được tin thay đổi kịp trước khi gõ thì tự nhận bản mới, không có gì để xung đột)
  const live = /\/api\/video\/jobs\/[^/]+(\/events[^/]*|\/cues)?$/;
  await second.route(live, (route) => route.abort());

  await target(page, 1).fill('Bản của thẻ một.');
  await saved(page);
  await second.getByRole('textbox', { name: 'Bản dịch đoạn 2', exact: true }).fill('Bản của thẻ hai.');
  const conflict = second.getByTestId('save-conflict');
  await expect(conflict).toContainText('Phụ đề đã được sửa ở nơi khác', { timeout: 10_000 });
  expect((await cuesInDb(jobId)).map((c) => c.target_text).slice(0, 2)).toEqual(['Bản của thẻ một.', 'Hôm nay chúng ta học điều mới.']);

  await second.unroute(live);
  await conflict.getByRole('button', { name: 'Tải lại phụ đề' }).click();
  await expect(conflict).toBeHidden();
  await expect(second.getByRole('textbox', { name: 'Bản dịch đoạn 1', exact: true })).toHaveValue('Bản của thẻ một.');
  await expect(second.getByRole('textbox', { name: 'Bản dịch đoạn 2', exact: true })).toHaveValue('Hôm nay chúng ta học điều mới.');
  await second.close();
});
