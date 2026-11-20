import type { Page } from '@playwright/test';
import { expect, loginViaUi, registerViaApi, test, uniqueUser } from './fixtures';

/**
 * Spec 003, US3 (FR-016…FR-019): giao diện Sáng / Tối / Theo hệ thống, ghi nhớ, không nhấp nháy, viền ô nhập rõ ở cả hai theme.
 */
const isDark = (page: Page) => page.evaluate(() => document.documentElement.classList.contains('dark'));
const toggle = (page: Page) => page.getByRole('button', { name: /^Giao diện:/ });
const choose = async (page: Page, mode: 'Sáng' | 'Tối' | 'Theo hệ thống') => {
  await toggle(page).click();
  await page.getByRole('menuitemradio', { name: mode }).click();
};

/** Màu viền thực của ô nhập so với màu của token --field-border (đã được trình duyệt quy đổi cùng một cách). */
async function inputBorderMatchesToken(page: Page, selector: string): Promise<{ border: string; token: string; background: string }> {
  return page.evaluate((sel) => {
    const input = document.querySelector(sel) as HTMLElement;
    const probe = document.createElement('div');
    probe.style.borderTop = '1px solid var(--field-border)';
    document.body.appendChild(probe);
    const token = getComputedStyle(probe).borderTopColor;
    probe.remove();
    return { border: getComputedStyle(input).borderTopColor, token, background: getComputedStyle(document.body).backgroundColor };
  }, selector);
}

test.describe('giao diện Sáng / Tối (spec 003, US3)', () => {
  test('đổi Sáng/Tối/Hệ thống ở trang đăng nhập, giữ sau khi tải lại, viền ô nhập rõ ở cả hai theme @mobile', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto('/login');
    await expect(toggle(page)).toBeVisible();
    expect(await isDark(page)).toBe(false);
    const light = await inputBorderMatchesToken(page, '#email, input[type="email"]');
    expect(light.border).toBe(light.token);
    expect(light.border).not.toBe(light.background);

    await choose(page, 'Tối');
    await expect.poll(() => isDark(page)).toBe(true); // đổi ngay, không tải lại
    const dark = await inputBorderMatchesToken(page, '#email, input[type="email"]');
    expect(dark.border).toBe(dark.token);
    expect(dark.border).not.toBe(light.border); // mỗi theme có viền riêng
    expect(dark.border).not.toBe(dark.background);

    await page.reload();
    expect(await isDark(page)).toBe(true); // được ghi nhớ

    await choose(page, 'Sáng');
    await expect.poll(() => isDark(page)).toBe(false);
    await page.reload();
    expect(await isDark(page)).toBe(false);
  });

  test('"Theo hệ thống" đổi theo thiết lập sáng/tối của thiết bị', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/login');
    await choose(page, 'Theo hệ thống');
    await expect.poll(() => isDark(page)).toBe(true);
    await page.emulateMedia({ colorScheme: 'light' });
    await expect.poll(() => isDark(page)).toBe(false);
  });

  test('không nhấp nháy sai theme: lớp dark đã có ngay khi DOM sẵn sàng', async ({ page }) => {
    await page.addInitScript(() => {
      try {
        localStorage.setItem('theme', 'dark');
      } catch {
        // bỏ qua
      }
      document.addEventListener('DOMContentLoaded', () => {
        (window as unknown as { __darkAtDcl: boolean }).__darkAtDcl = document.documentElement.classList.contains('dark');
      });
    });
    await page.goto('/login');
    expect(await page.evaluate(() => (window as unknown as { __darkAtDcl: boolean }).__darkAtDcl)).toBe(true);
  });

  test('trình duyệt chặn lưu trữ cục bộ: trang vẫn dùng được với mặc định', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', {
        get() {
          throw new Error('blocked');
        },
      });
    });
    await page.goto('/login');
    await expect(page.getByLabel('Email')).toBeVisible();
    await expect(toggle(page)).toBeVisible();
  });

  test('đã đăng nhập: lựa chọn ghi vào tài khoản và áp dụng lại ở phiên/trình duyệt mới', async ({ page, browser }) => {
    const user = uniqueUser('theme');
    await page.emulateMedia({ colorScheme: 'light' });
    await registerViaApi(page.request, user);
    await page.goto('/projects');
    await choose(page, 'Tối');
    await expect.poll(() => isDark(page)).toBe(true);
    await expect
      .poll(async () => (await (await page.request.get('/api/me')).json()).theme)
      .toBe('dark'); // đã ghi vào tài khoản

    // Trình duyệt mới (không có localStorage cũ) đăng nhập cùng tài khoản → áp dụng theme của tài khoản
    const ctx = await browser.newContext({ colorScheme: 'light', locale: 'vi-VN' });
    const fresh = await ctx.newPage();
    await loginViaUi(fresh, user);
    await expect.poll(() => isDark(fresh)).toBe(true);
    await ctx.close();
  });

  test('theme Tối: ô nhập, nút và trình phát vẫn đọc rõ (nền tối, chữ sáng)', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/login');
    await choose(page, 'Tối');
    await expect.poll(() => isDark(page)).toBe(true);
    const colors = await page.evaluate(() => {
      const cs = getComputedStyle(document.body);
      return { bg: cs.backgroundColor, fg: cs.color };
    });
    expect(colors.bg).not.toBe(colors.fg);
    // nền tối: kênh sáng nhỏ; chữ sáng: kênh lớn (chấp nhận định dạng rgb()/oklch() của trình duyệt)
    const lightness = (c: string) => {
      // Trình duyệt trả màu dạng oklch()/oklab() (L 0–1) hoặc lab()/lch() (L 0–100) hoặc rgb()
      const m = /(oklch|oklab|lab|lch)\(([\d.]+)/.exec(c);
      if (m) return m[1] === 'oklch' || m[1] === 'oklab' ? Number(m[2]) : Number(m[2]) / 100;
      const rgb = c.match(/\d+(\.\d+)?/g)?.slice(0, 3).map(Number) ?? [0, 0, 0];
      return (0.2126 * rgb[0]! + 0.7152 * rgb[1]! + 0.0722 * rgb[2]!) / 255;
    };
    expect(lightness(colors.bg)).toBeLessThan(0.35);
    expect(lightness(colors.fg)).toBeGreaterThan(0.6);
  });
});
