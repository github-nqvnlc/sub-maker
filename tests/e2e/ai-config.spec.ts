import { startMockProvider, type MockProvider } from '../../mock-provider/server';
import { E2E_ADMIN, expect, loginViaUi, registerViaApi, test, uniqueUser } from './fixtures';

/**
 * US9 (quickstart #1 và #10): Administrator cấu hình AI chung; User được thêm vào danh sách mới có cấu hình riêng.
 * Máy chủ nhà cung cấp giả chạy ngay trong tiến trình test; web E2E (E2E_MODE) cho phép http/loopback.
 */
let mock: MockProvider;

test.beforeAll(async () => {
  mock = await startMockProvider();
});
test.afterAll(async () => {
  await mock.close();
});

const SHARED_KEY = 'sk-e2e-shared-key-9f8e7d6c5b4a';
const PRIVATE_KEY = 'sk-e2e-private-key-1a2b3c4d5e6f';

test.describe('cấu hình AI (US9)', () => {
  test('Administrator cấu hình AI chung, khóa được che và kiểm tra kết nối thành công', async ({ page }) => {
    await loginViaUi(page, E2E_ADMIN);
    await page.goto('/admin/ai-configs');

    await page.getByRole('tab', { name: /FPT\.AI/ }).click();
    await page.getByLabel('Địa chỉ gốc (Base URL)').fill(`${mock.url}/s/ok/v1`);
    await page.getByLabel('Khóa API').fill(SHARED_KEY);
    await page.getByRole('button', { name: 'Lưu cấu hình' }).click();
    await expect(page.getByText('Đã lưu cấu hình')).toBeVisible();

    // Khóa chỉ hiện gợi ý vài ký tự cuối, không bao giờ hiện đầy đủ
    await expect(page.getByText('…5b4a').first()).toBeVisible();
    await expect(page.getByText(SHARED_KEY)).toHaveCount(0);
    expect(await page.content()).not.toContain(SHARED_KEY);

    await page.getByRole('button', { name: 'Kiểm tra kết nối' }).click();
    await expect(page.getByText('Kết nối thành công').first()).toBeVisible();

    // địa chỉ nội bộ nguy hiểm bị từ chối
    await page.getByLabel('Địa chỉ gốc (Base URL)').fill('http://169.254.169.254/latest');
    await page.getByRole('button', { name: 'Lưu cấu hình' }).click();
    await expect(page.getByText(/không hợp lệ hoặc không được phép/)).toBeVisible();
  });

  test('User mới không có mục cấu hình riêng; được thêm vào danh sách thì nhập được; bị gỡ thì mất quyền', async ({ page, request, browser }) => {
    const user = uniqueUser('custom');
    await registerViaApi(request, user);

    // 1) Chưa trong danh sách: không có mục "Cấu hình AI" và /settings/ai là 404
    const userCtx = await browser.newContext();
    const up = await userCtx.newPage();
    await loginViaUi(up, user);
    await up.goto('/settings/profile');
    await expect(up.getByRole('link', { name: 'Cấu hình AI' })).toHaveCount(0);
    expect((await up.goto('/settings/ai'))?.status()).toBe(404);

    // 2) Administrator thêm vào danh sách
    await loginViaUi(page, E2E_ADMIN);
    await page.goto('/admin/custom-ai-users');
    await page.getByLabel('Thêm User').fill(user.email);
    const candidate = page.getByRole('listitem').filter({ hasText: user.email });
    await expect(candidate).toBeVisible();
    await candidate.getByRole('button', { name: 'Thêm User' }).click();
    await expect(page.getByText('Đã thêm vào danh sách')).toBeVisible();

    // 3) User thấy mục cấu hình riêng và lưu được cấu hình
    await up.goto('/settings/profile');
    await expect(up.getByRole('link', { name: 'Cấu hình AI' })).toBeVisible();
    await up.getByRole('link', { name: 'Cấu hình AI' }).click();
    await up.getByRole('tab', { name: /FPT AI Marketplace/ }).click();
    await up.getByLabel('Địa chỉ gốc (Base URL)').fill(`${mock.url}/s/ok/v1`);
    await up.getByLabel('Khóa API').fill(PRIVATE_KEY);
    await up.getByRole('button', { name: 'Lưu cấu hình' }).click();
    await expect(up.getByText('Đã lưu cấu hình')).toBeVisible();
    await up.getByRole('button', { name: 'Kiểm tra kết nối' }).click();
    await expect(up.getByText('Kết nối thành công').first()).toBeVisible();

    // 4) Administrator gỡ khỏi danh sách → User mất quyền, cấu hình riêng bị vô hiệu
    await page.reload();
    const inList = page.getByRole('listitem').filter({ hasText: user.email });
    await expect(inList).toBeVisible();
    await inList.getByRole('button', { name: 'Gỡ khỏi danh sách' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Gỡ khỏi danh sách' }).click();
    await expect(page.getByText('Đã gỡ khỏi danh sách')).toBeVisible();

    expect((await up.goto('/settings/ai'))?.status()).toBe(404);
    await up.goto('/settings/profile');
    await expect(up.getByRole('link', { name: 'Cấu hình AI' })).toHaveCount(0);
    await userCtx.close();
  });
});
