import type { Page } from '@playwright/test';
import { startMockProvider, type MockProvider } from '../../mock-provider/server';
import { E2E_ADMIN, expect, test } from './fixtures';
import { expectNoHorizontalScroll } from './overlay-helpers';
import { hdr, jobRow, makeVideoFile, openVideoTab, startUpload, videoProject, waitVideoJob } from './video-helpers';

/** Spec 006, T138: kiểm bố cục 375 px ở cả hai theme Sáng và Tối trên tab, trình biên tập và trang quản trị. */
test.use({ viewport: { width: 375, height: 812 } });

let mock: MockProvider;
test.beforeAll(async () => {
  mock = await startMockProvider();
});
test.afterAll(async () => {
  await mock.close();
});

async function setTheme(page: Page, mode: 'Sáng' | 'Tối') {
  await page.getByRole('button', { name: /^Giao diện:/ }).click();
  await page.getByRole('menuitemradio', { name: mode }).click();
  await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(mode === 'Tối');
}

async function checkCanvasFits(page: Page) {
  const box = await page.getByTestId('video-preview-canvas').boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeLessThanOrEqual(375);
}

test('tab Dịch Video và trình biên tập ở 375 px không tràn ngang — Sáng & Tối @mobile', async ({ page }) => {
  test.setTimeout(180_000);
  const p = await videoProject(page, mock);
  await openVideoTab(page, p.id);
  await expect(page.getByTestId('upload-storage-used')).toBeVisible();
  await startUpload(page, makeVideoFile('mobile.mp4', { size: '360x640' }));
  await waitVideoJob(page, p.id, 'review_ready', 90_000);

  for (const mode of ['Sáng', 'Tối'] as const) {
    await page.goto(`/projects/${p.id}?tab=video`);
    await expect(page.getByRole('heading', { name: 'Dịch video và gắn phụ đề' })).toBeVisible();
    await setTheme(page, mode);
    await expect(page.getByTestId('upload-storage-used')).toBeVisible();
    await expect(page.getByTestId('video-storage-used')).toBeVisible();
    await expectNoHorizontalScroll(page);

    await jobRow(page, 'mobile.mp4').getByRole('link', { name: 'Mở' }).click();
    await expect(page.getByTestId('cue-row')).toHaveCount(3);
    await expect(page.getByTestId('video-preview-canvas')).toHaveAttribute('data-fonts', 'ready');
    await checkCanvasFits(page);
    await expectNoHorizontalScroll(page);

    await page.getByRole('button', { name: 'Tìm và thay thế' }).click();
    await expect(page.getByRole('heading', { name: 'Tìm và thay thế' })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await page.getByRole('button', { name: 'Đóng tìm kiếm' }).click();

    await page.getByRole('tab', { name: 'Kiểu chữ' }).click();
    await expect(page.getByRole('heading', { name: 'Kiểu phụ đề' })).toBeVisible();
    await page.getByRole('combobox', { name: 'Vùng bị che của mạng xã hội' }).click();
    await page.getByRole('option', { name: 'TikTok' }).click();
    await checkCanvasFits(page);
    await expectNoHorizontalScroll(page);

    await page.getByRole('tab', { name: 'Từ điển' }).click();
    await expect(page.getByRole('heading', { name: 'Từ điển thuật ngữ' })).toBeVisible();
    await expectNoHorizontalScroll(page);

    await page.getByRole('tab', { name: 'Xuất video' }).click();
    await expect(page.getByRole('heading', { name: 'Xuất video', exact: true })).toBeVisible();
    await page.getByRole('combobox', { name: 'Kiểu xuất' }).click();
    await page.getByRole('option', { name: 'Xuất riêng lớp phụ đề' }).click();
    await expect(page.getByRole('combobox', { name: 'Nền và định dạng' })).toBeVisible();
    await expectNoHorizontalScroll(page);
  }
});

test('trang quản trị thống kê, cài đặt và người dùng ở 375 px — Sáng & Tối @mobile', async ({ page }) => {
  test.setTimeout(120_000);
  const res = await page.request.post('/api/auth/sign-in/email', { data: E2E_ADMIN, headers: hdr });
  expect(res.ok()).toBeTruthy();

  for (const mode of ['Sáng', 'Tối'] as const) {
    await page.goto('/admin/stats');
    await setTheme(page, mode);
    await expect(page.getByTestId('admin-stat-video')).toBeVisible();
    await expectNoHorizontalScroll(page);

    await page.goto('/admin/settings');
    await expect(page.getByLabel('Hạn mức video mỗi người dùng (GB)')).toBeVisible();
    await expectNoHorizontalScroll(page);

    await page.goto('/admin/users');
    await expect(page.getByRole('heading', { name: 'Người dùng' })).toBeVisible();
    await expectNoHorizontalScroll(page);
  }
});
