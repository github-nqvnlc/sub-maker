import type { Page } from '@playwright/test';
import { E2E_ADMIN, ORIGIN, expect, loginViaUi, registerViaApi, test, uniqueUser } from './fixtures';
import { createProject } from './helpers';

/** Spec 003, US4 (FR-020…FR-024): đổi Tiếng Việt ↔ English, ghi nhớ, không sót chữ Việt ở phần giao diện; nội dung người dùng giữ nguyên. */
const VI_CHARS = /[ăâđêôơưĂÂĐÊÔƠƯàáạảãằắặẳẵầấậẩẫèéẹẻẽềếệểễìíịỉĩòóọỏõồốộổỗờớợởỡùúụủũừứựửữỳýỵỷỹ]/;
/** Tên Project do người dùng đặt (nội dung, không dịch) — loại khỏi phép kiểm tra "khung" giao diện. */
const USER_CONTENT = /Lịch sử Việt Nam|Ban Mai/; // tên Project và tên giọng đọc là dữ liệu, không dịch
const switcher = (page: Page) => page.getByRole('button', { name: /^(Ngôn ngữ|Language):/ });
const lang = (page: Page) => page.evaluate(() => document.documentElement.lang);
async function choose(page: Page, label: 'Tiếng Việt' | 'English') {
  await switcher(page).click();
  await page.getByRole('menuitemradio', { name: label }).click();
}

/** Mọi chữ của "khung" giao diện (tiêu đề, điều hướng, nhãn, nút) — không tính nội dung người dùng như tên Project hay dòng bảng. */
async function chromeTexts(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const sel = 'main h1, main h2, main nav a, main label, main button, aside nav a, header button, header [aria-label], [role="tab"]';
    const out = new Set<string>();
    for (const el of document.querySelectorAll(sel)) {
      const t = (el.textContent ?? '').trim();
      if (t) out.add(t);
      const a = el.getAttribute('aria-label');
      if (a) out.add(a);
    }
    return [...out];
  });
}
async function expectNoVietnameseChrome(page: Page, where: string) {
  const texts = await chromeTexts(page);
  expect(texts.length, `${where}: không đọc được chữ giao diện`).toBeGreaterThan(0);
  const bad = texts.filter((t) => VI_CHARS.test(t) && !USER_CONTENT.test(t));
  expect(bad, `${where}: còn chữ tiếng Việt: ${bad.join(' | ')}`).toEqual([]);
}

test.describe('đa ngôn ngữ giao diện (spec 003, US4)', () => {
  test('đổi English ở trang đăng nhập, giữ sau khi tải lại, đổi lại tiếng Việt @mobile', async ({ page }) => {
    await page.goto('/login');
    expect(await lang(page)).toBe('vi');
    await expect(page.getByRole('heading', { name: 'Đăng nhập' }).or(page.getByText('Đăng nhập').first())).toBeVisible();

    await choose(page, 'English');
    await expect.poll(() => lang(page)).toBe('en');
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible(); // đổi ngay, không tải lại
    await expect(page.getByLabel('Password')).toBeVisible();

    await page.reload();
    expect(await lang(page)).toBe('en');
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();

    await choose(page, 'Tiếng Việt');
    await expect.poll(() => lang(page)).toBe('vi');
    await expect(page.getByRole('button', { name: 'Đăng nhập' })).toBeVisible();
  });

  test('thông báo lỗi đăng nhập theo ngôn ngữ, giữ nguyên dữ liệu đang nhập khi đổi ngôn ngữ', async ({ page }) => {
    await page.goto('/login');
    await choose(page, 'English');
    await expect.poll(() => lang(page)).toBe('en');
    await page.getByLabel('Email').fill('nobody@example.test');
    await page.getByLabel('Password').fill('Wrong-password-123');
    // đổi lại ngôn ngữ giữa chừng: không mất chữ đã gõ
    await choose(page, 'Tiếng Việt');
    await expect(page.getByLabel('Email')).toHaveValue('nobody@example.test');
    await choose(page, 'English');
    await expect.poll(() => lang(page)).toBe('en');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.locator('p[role="alert"]')).toContainText('Incorrect email or password.');
  });

  test('đi qua các màn hình chính ở English: không còn chữ Việt ở phần giao diện; nội dung người dùng không bị dịch', async ({ page }) => {
    const user = { ...uniqueUser('lang'), displayName: 'Alice Tester' };
    await registerViaApi(page.request, user);
    const project = await createProject(page, 'Lịch sử Việt Nam');

    await page.goto('/projects');
    await choose(page, 'English');
    await expect.poll(() => lang(page)).toBe('en');

    for (const [url, where] of [
      ['/projects', 'Projects'],
      [`/projects/${project.id}`, 'Project detail'],
      ['/dashboard', 'Dashboard'],
      ['/settings/profile', 'Profile'],
    ] as const) {
      await page.goto(url);
      await expect(page.getByRole('main')).toBeVisible();
      await expectNoVietnameseChrome(page, where);
    }

    // Tên Project do người dùng đặt giữ nguyên tiếng Việt; tìm không dấu vẫn hoạt động ở English
    await page.goto('/projects');
    await expect(page.getByText('Lịch sử Việt Nam')).toBeVisible();
    await page.getByPlaceholder('Search by name or description…').fill('lich su viet');
    await expect(page.getByText('Lịch sử Việt Nam')).toBeVisible();
    await page.getByPlaceholder('Search by name or description…').fill('khong co gi');
    await expect(page.getByText('Lịch sử Việt Nam')).toBeHidden();

    // Hộp thoại tạo Project
    await page.getByRole('button', { name: 'Create Project' }).first().click();
    await expect(page.getByRole('dialog').getByLabel('Project name')).toBeVisible();
    await expectNoVietnameseChromeDialog(page);
  });

  test('khu quản trị ở English (tab, cài đặt hệ thống)', async ({ page }) => {
    await loginViaUi(page, E2E_ADMIN);
    try {
      await page.goto('/projects');
      await choose(page, 'English');
      await expect.poll(() => lang(page)).toBe('en');
      for (const path of ['/admin/users', '/admin/ai-configs', '/admin/custom-ai-users', '/admin/stats', '/admin/settings']) {
        await page.goto(path);
        await expect(page.getByRole('main')).toBeVisible();
        await expectNoVietnameseChrome(page, path);
      }
      await expect(page.getByRole('main').locator('nav a[aria-current="page"]')).toHaveText('System settings');
    } finally {
      // Tài khoản Admin dùng chung cho cả bộ e2e (1 worker, chạy lần lượt): trả ngôn ngữ về tiếng Việt cho spec sau.
      await choose(page, 'Tiếng Việt');
      await expect.poll(() => lang(page)).toBe('vi');
    }
  });

  test('đã đăng nhập: ngôn ngữ ghi vào tài khoản và áp dụng ở trình duyệt mới', async ({ page, browser }) => {
    const user = { ...uniqueUser('langsync'), displayName: 'Bob Tester' };
    await registerViaApi(page.request, user);
    await page.goto('/projects');
    await choose(page, 'English');
    await expect.poll(() => lang(page)).toBe('en');
    await expect.poll(async () => (await (await page.request.get('/api/me')).json()).locale).toBe('en');

    const ctx = await browser.newContext({ locale: 'vi-VN' });
    const fresh = await ctx.newPage();
    await loginViaUi(fresh, user); // trang đăng nhập hiện tiếng Việt (chưa có cookie), vào ứng dụng thì lấy ngôn ngữ của tài khoản
    await expect.poll(() => lang(fresh), { timeout: 15_000 }).toBe('en');
    await expect(fresh.getByRole('button', { name: 'Create Project' }).first()).toBeVisible();
    await ctx.close();
  });

  test('API trả lỗi theo ngôn ngữ của cookie', async ({ page }) => {
    await page.context().addCookies([{ name: 'locale', value: 'en', url: ORIGIN }]);
    const res = await page.request.get('/api/projects');
    expect(res.status()).toBe(401);
    expect((await res.json()).error.message).toBe('Please sign in to continue.');
  });
});

async function expectNoVietnameseChromeDialog(page: Page) {
  const texts = await page.getByRole('dialog').evaluate((d) => [...d.querySelectorAll('h2, label, button, p')].map((e) => (e.textContent ?? '').trim()).filter(Boolean));
  const bad = texts.filter((t) => VI_CHARS.test(t));
  expect(bad, `hộp thoại còn chữ tiếng Việt: ${bad.join(' | ')}`).toEqual([]);
}
