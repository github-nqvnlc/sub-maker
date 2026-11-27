import { startMockProvider, type MockProvider } from '../../mock-provider/server';
import { E2E_ADMIN, expect, test } from './fixtures';
import { expectNoHorizontalScroll } from './overlay-helpers';
import { adminSettings, hdr, jobRow, makeVideoFile, openVideoTab, startUpload, videoJobs, videoProject } from './video-helpers';

/**
 * Spec 006, US7 (T118, quickstart §6): dung lượng video đã dùng, chọn nhiều và xóa có xác nhận, thống kê của Administrator. Dừng, phục
 * hồi sau khởi động lại, hạn mức đồng thời, tự xóa và đối soát có kiểm thử tích hợp riêng.
 */
let mock: MockProvider;
test.beforeAll(async () => {
  mock = await startMockProvider();
});
test.afterAll(async () => {
  await mock.close();
});

test('dung lượng video, chọn nhiều rồi xóa có xác nhận; Administrator thấy dung lượng theo người dùng', async ({ page }) => {
  test.setTimeout(180_000);
  await adminSettings(page, { videoMaxJobsPerUser: 2 });
  const p = await videoProject(page, mock);
  await openVideoTab(page, p.id);
  const used = page.getByTestId('video-storage-used');
  await expect(used).toHaveText(/đang dùng 0 B \/ /);

  for (const name of ['mot.mp4', 'hai.mp4']) {
    await startUpload(page, makeVideoFile(name));
    await expect(jobRow(page, name)).toBeVisible();
  }
  await expect.poll(async () => (await videoJobs(page, p.id)).map((j) => j.displayStatus).sort().join(), { timeout: 120_000 }).toBe('review_ready,review_ready');
  await expect(used).not.toHaveText(/dùng 0 B/);
  await expect(used).not.toHaveText(/giữ chỗ/);

  // Administrator: dung lượng theo người dùng và toàn hệ thống
  await page.request.post('/api/auth/sign-out', { data: {}, headers: hdr });
  expect((await page.request.post('/api/auth/sign-in/email', { data: E2E_ADMIN, headers: hdr })).ok()).toBeTruthy();
  await page.goto('/admin/stats');
  await expect(page.getByTestId('admin-stat-video')).toContainText('/');
  const mine = page.getByTestId('admin-stat-row').filter({ hasText: p.user.email });
  await expect(mine).toBeVisible();
  await expect(mine.getByRole('cell').nth(7)).toHaveText(/KB|MB/);
  await page.request.post('/api/auth/sign-out', { data: {}, headers: hdr });
  expect((await page.request.post('/api/auth/sign-in/email', { data: { email: p.user.email, password: p.user.password }, headers: hdr })).ok()).toBeTruthy();

  await openVideoTab(page, p.id);
  await page.getByRole('checkbox', { name: 'Chọn tất cả việc dịch' }).click();
  await expect(page.getByRole('status').filter({ hasText: '2 đã chọn' })).toBeVisible();
  await page.getByRole('button', { name: 'Xóa đã chọn' }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText('2 việc dịch, trả lại');
  for (const name of ['mot.mp4', 'hai.mp4']) await expect(dialog.getByRole('listitem').filter({ hasText: name })).toBeVisible();
  await dialog.getByRole('button', { name: 'Hủy' }).click();
  expect(await videoJobs(page, p.id)).toHaveLength(2);

  await page.getByRole('button', { name: 'Xóa đã chọn' }).click();
  await dialog.getByRole('button', { name: 'Xóa' }).click();
  await expect(page.getByText('Đã xóa 2 việc dịch')).toBeVisible();
  await expect(page.getByText('Chưa có việc dịch video nào')).toBeVisible();
  await expect(used).toHaveText(/đang dùng 0 B \/ /);
  expect(await videoJobs(page, p.id)).toHaveLength(0);
  await expectNoHorizontalScroll(page);
  await adminSettings(page, { videoMaxJobsPerUser: 1 });
});
