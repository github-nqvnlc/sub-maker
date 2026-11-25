import type { Page } from '@playwright/test';
import { startMockProvider, type MockProvider } from '../../mock-provider/server';
import { expect, test } from './fixtures';
import { expectNoHorizontalScroll, openOverlay, overlayJobs, overlayProject, usedBytes, waitOverlay } from './overlay-helpers';

/** Spec 005, US6: quản lý nhiều lần xuất; kèm English, theme Tối và 375 px (FR-048). */
let mock: MockProvider;
test.beforeAll(async () => {
  mock = await startMockProvider();
});
test.afterAll(async () => {
  await mock.close();
});

const VI_CHARS = /[ăâđêôơưĂÂĐÊÔƠƯàáạảãằắặẳẵầấậẩẫèéẹẻẽềếệểễìíịỉĩòóọỏõồốộổỗờớợởỡùúụủũừứựửữỳýỵỷỹ]/;
const select = async (page: Page, label: string, option: string | RegExp) => {
  await page.getByRole('combobox', { name: label, exact: true }).click();
  await page.getByRole('option', { name: option }).click();
};
const exportVideo = async (page: Page, projectId: string, count: number) => {
  await page.getByRole('button', { name: 'Xuất Video Overlay' }).click();
  await expect.poll(async () => (await overlayJobs(page, projectId)).length).toBe(count);
};
const rows = (page: Page) => page.getByRole('row').filter({ hasText: 'sample-10s.srt' });

test.describe('quản lý các lần xuất (US6)', () => {
  test('dừng, chạy lại, nhật ký, xem và dùng lại cấu hình, xóa hai mục cùng lúc', async ({ page }) => {
    const p = await overlayProject(page, mock, 'manage');
    await openOverlay(page, p.id);
    await select(page, 'Tỉ lệ khung hình', /^1:1/);
    await exportVideo(page, p.id, 1);
    await waitOverlay(page, p.id, 0, /^completed$/);
    await select(page, 'Tỉ lệ khung hình', /^9:16/);

    // Hai lần xuất liên tiếp: lần sau chờ trong hàng đợi nên dừng được ngay; có số đang chạy ở nhãn tab và huy hiệu của Project
    await exportVideo(page, p.id, 2);
    await exportVideo(page, p.id, 3);
    await expect(page.getByRole('tab', { name: /Video Overlay \(3\).*đang chạy/ })).toBeVisible();
    await expect(page.locator('h1 + *, h1 ~ *').filter({ hasText: 'Đang chạy' }).first()).toBeVisible();
    // Vượt 2 tiến trình cùng lúc: bị từ chối kèm thông báo
    await page.getByRole('button', { name: 'Xuất Video Overlay' }).click();
    await expect(page.getByText('Bạn đang có đủ số tiến trình xuất video cho phép')).toBeVisible();

    await rows(page).first().getByRole('button', { name: 'Dừng' }).click();
    await expect(rows(page).first().getByText('Đã dừng')).toBeVisible();
    await waitOverlay(page, p.id, 1, /^completed$/);
    await rows(page).first().getByRole('button', { name: 'Chạy lại' }).click();
    await waitOverlay(page, p.id, 0, /^completed$/);
    await expect(rows(page).first().getByText('Hoàn tất')).toBeVisible();
    await rows(page).first().getByRole('button', { name: 'Nhật ký' }).click();
    const log = page.getByRole('dialog').getByRole('log');
    await expect(log).toContainText('Đã dừng theo yêu cầu');
    await expect(log).toContainText('Người dùng yêu cầu chạy lại');
    await page.keyboard.press('Escape');

    // Cấu hình đã chốt của lần xuất đầu (1:1) xem được và dùng lại được
    const first = rows(page).last();
    await first.getByRole('button', { name: 'Xem cấu hình' }).click();
    await expect(page.getByRole('dialog')).toContainText('1:1 vuông (1080×1080)');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toBeHidden();
    await first.getByRole('button', { name: 'Dùng lại cấu hình' }).click();
    await expect(page.getByRole('combobox', { name: 'Tỉ lệ khung hình' })).toContainText('1:1');
    await expect(page.getByText('Đã nạp cấu hình của lần xuất này')).toBeVisible();

    // Xóa hai mục cùng lúc: nêu số lượng và dung lượng, trả lại hạn mức
    const list = await overlayJobs(page, p.id);
    const before = await usedBytes(page, p.id);
    await rows(page).nth(0).getByRole('checkbox').check();
    await rows(page).nth(1).getByRole('checkbox').check();
    await expect(page.getByRole('status').filter({ hasText: '2 đã chọn' })).toBeVisible();
    await page.getByRole('button', { name: 'Xóa đã chọn' }).click();
    const confirm = page.getByRole('alertdialog');
    await expect(confirm).toContainText('Xóa các lần xuất đã chọn?');
    await expect(confirm).toContainText(/2 lần xuất, trả lại [\d.]+ (KB|MB)/);
    await confirm.getByRole('button', { name: 'Xóa' }).click();
    await expect(rows(page)).toHaveCount(1);
    expect(await usedBytes(page, p.id)).toBe(before - list[0]!.sizeBytes! - list[1]!.sizeBytes!);
    await expect(page.getByText(/Video đã xuất đang dùng/)).toBeVisible();
  });

  test('English và theme Tối: không sót chữ Việt ở giao diện tab; không cuộn ngang @mobile', async ({ page }) => {
    const p = await overlayProject(page, mock, 'english');
    await page.goto(`/projects/${p.id}`);
    await page.getByRole('button', { name: /^Giao diện:/ }).click();
    await page.getByRole('menuitemradio', { name: 'Tối' }).click();
    await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(true);
    await page.getByRole('button', { name: /^Ngôn ngữ:/ }).click();
    await page.getByRole('menuitemradio', { name: 'English' }).click();
    await expect.poll(() => page.evaluate(() => document.documentElement.lang)).toBe('en');
    await openOverlay(page, p.id);
    await expectNoHorizontalScroll(page);

    const panel = page.getByRole('tabpanel');
    const text = async () => (await panel.innerText()).split('\n').filter((l) => VI_CHARS.test(l));
    expect(await text(), 'chữ Việt còn sót trong tab').toEqual([]);
    for (const box of await panel.getByRole('combobox').all()) {
      await box.click();
      const opts = await page.getByRole('option').allInnerTexts();
      expect(opts.filter((o) => VI_CHARS.test(o)), 'chữ Việt còn sót trong danh sách chọn').toEqual([]);
      await page.keyboard.press('Escape');
    }
    // Xuất ở English: nhật ký và cấu hình cũng theo ngôn ngữ người xem
    await page.getByRole('button', { name: 'Export Video Overlay' }).click();
    await waitOverlay(page, p.id, 0, /^completed$/);
    await rows(page).first().getByRole('button', { name: 'Log' }).click();
    await expect(page.getByRole('dialog').getByRole('log')).not.toContainText(VI_CHARS);
    await page.keyboard.press('Escape');
    expect(await text(), 'chữ Việt còn sót sau khi xuất').toEqual([]);
    await expectNoHorizontalScroll(page);
  });

  test('khởi động lại trang giữa lúc xuất vẫn thấy tiến độ', async ({ page }) => {
    const p = await overlayProject(page, mock, 'resume');
    await openOverlay(page, p.id);
    await exportVideo(page, p.id, 1);
    await openOverlay(page, p.id);
    await expect(rows(page).first().getByRole('progressbar')).toBeVisible();
    await waitOverlay(page, p.id, 0, /^completed$/);
    await expect(rows(page).first().getByText('100%')).toBeVisible();
  });
});
