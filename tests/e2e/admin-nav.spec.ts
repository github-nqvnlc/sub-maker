import type { Page } from '@playwright/test';
import { E2E_ADMIN, expect, loginViaUi, registerViaApi, test, uniqueUser } from './fixtures';

/** Spec 003, US6 (FR-029, SC-008): thanh tab quản trị làm nổi bật đúng tab của trang đang mở. */
const PAGES = [
  { path: '/admin/users', label: 'Người dùng' },
  { path: '/admin/ai-configs', label: 'Cấu hình AI chung' },
  { path: '/admin/custom-ai-users', label: 'User dùng AI riêng' },
  { path: '/admin/stats', label: 'Thống kê hệ thống' },
  { path: '/admin/settings', label: 'Cài đặt hệ thống' },
];

const nav = (page: Page) => page.locator('main nav[aria-label]').first();

async function expectOnlyActive(page: Page, label: string) {
  const links = nav(page).getByRole('link');
  await expect(links).toHaveCount(PAGES.length);
  // Đúng một tab được đánh dấu là trang hiện tại, và là tab đúng
  await expect(nav(page).locator('[aria-current="page"]')).toHaveCount(1);
  await expect(nav(page).locator('[aria-current="page"]')).toHaveText(label);
  // Nổi bật không chỉ bằng màu: chữ đậm hơn và có gạch chân (viền dưới) khác tab thường
  const styles = await links.evaluateAll((els) =>
    els.map((el) => {
      const cs = getComputedStyle(el);
      return { text: el.textContent ?? '', weight: Number(cs.fontWeight), underline: cs.borderBottomColor, bg: cs.backgroundColor, current: el.getAttribute('aria-current') };
    }),
  );
  const active = styles.find((s) => s.current === 'page')!;
  const others = styles.filter((s) => s.current !== 'page');
  for (const o of others) {
    expect(active.weight).toBeGreaterThan(o.weight);
    expect(active.underline).not.toBe(o.underline);
    expect(active.bg).not.toBe(o.bg);
  }
}

test.describe('tab quản trị đang chọn (spec 003, US6)', () => {
  test('mỗi trang quản trị nổi bật đúng một tab và chuyển theo trang @mobile', async ({ page }) => {
    await loginViaUi(page, E2E_ADMIN);
    for (const p of PAGES) {
      await page.goto(p.path);
      await expect(page.getByRole('heading').first()).toBeVisible();
      await expectOnlyActive(page, p.label);
    }
    // bấm sang tab khác: nổi bật chuyển theo
    await page.goto('/admin/users');
    await nav(page).getByRole('link', { name: 'Cài đặt hệ thống' }).click();
    await expect(page).toHaveURL(/\/admin\/settings$/);
    await expectOnlyActive(page, 'Cài đặt hệ thống');
  });

  test('theme Tối vẫn nổi bật rõ (không chỉ dựa vào màu)', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await loginViaUi(page, E2E_ADMIN);
    await page.goto('/admin/settings');
    await page.getByRole('button', { name: /^Giao diện:/ }).click();
    await page.getByRole('menuitemradio', { name: 'Tối' }).click();
    await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(true);
    await expectOnlyActive(page, 'Cài đặt hệ thống');
  });

  test('User thường vào khu quản trị vẫn nhận 404', async ({ page }) => {
    const user = uniqueUser('adminnav');
    await registerViaApi(page.request, user);
    const res = await page.goto('/admin/settings');
    expect(res?.status()).toBe(404);
  });
});
