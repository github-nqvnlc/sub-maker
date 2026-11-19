import { E2E_ADMIN, PNG_1X1, expect, formAlert, loginViaUi, registerViaApi, test, uniqueUser } from './fixtures';

test.describe('tài khoản (US7)', () => {
  test('đăng ký → vào ứng dụng → đăng xuất → đăng nhập lại @mobile', async ({ page }) => {
    const user = uniqueUser('reg');
    await page.goto('/register');
    await page.getByLabel('Tên hiển thị').fill(user.displayName);
    await page.getByLabel('Email').fill(user.email);
    await page.getByLabel('Mật khẩu').fill(user.password);
    await page.getByRole('button', { name: 'Đăng ký' }).click();

    await expect(page).toHaveURL(/\/projects/);
    await expect(page.getByRole('heading', { name: 'Project' })).toBeVisible();

    // Đăng xuất qua menu người dùng (trên điện thoại nút hiển thị tên bị ẩn nhưng vẫn bấm được)
    await page.getByRole('button', { name: new RegExp(user.displayName.slice(0, 8)) }).or(page.locator('header button').last()).click();
    await page.getByRole('menuitem', { name: 'Đăng xuất' }).click();
    await expect(page).toHaveURL(/\/login/);

    await loginViaUi(page, user);
    await expect(page).toHaveURL(/\/projects/);
  });

  test('đăng ký bị từ chối khi mật khẩu quá phổ biến, hiển thị thông báo tiếng Việt', async ({ page }) => {
    const user = uniqueUser('weak');
    await page.goto('/register');
    await page.getByLabel('Tên hiển thị').fill(user.displayName);
    await page.getByLabel('Email').fill(user.email);
    await page.getByLabel('Mật khẩu').fill('password123');
    await page.getByRole('button', { name: 'Đăng ký' }).click();
    await expect(formAlert(page)).toContainText(/phổ biến/);
    await expect(page).toHaveURL(/\/register/);
  });

  test('đăng nhập sai mật khẩu hiển thị lỗi và ở lại trang đăng nhập', async ({ page, request }) => {
    const user = uniqueUser('bad');
    await registerViaApi(request, user);
    await loginViaUi(page, { email: user.email, password: 'Sai-Mat-Khau-123!' }, { expectSuccess: false });
    await expect(formAlert(page)).toContainText('không đúng');
    await expect(page).toHaveURL(/\/login/);
  });

  test('chưa đăng nhập vào trang trong ứng dụng thì bị chuyển về đăng nhập', async ({ page }) => {
    await page.goto('/projects');
    await expect(page).toHaveURL(/\/login/);
  });

  test('sửa hồ sơ và đổi ảnh đại diện', async ({ page, request }) => {
    const user = uniqueUser('prof');
    await registerViaApi(request, user);
    await loginViaUi(page, user);
    await page.goto('/settings/profile');

    await page.getByLabel('Tên hiển thị').fill('Hoàng Thị Tuyết');
    await page.getByLabel('Giới thiệu').fill('Tôi làm video giáo dục.');
    await page.getByRole('button', { name: 'Lưu' }).click();
    await expect(page.getByText('Đã lưu hồ sơ')).toBeVisible();

    await page.getByLabel('Ảnh đại diện').setInputFiles({ name: 'avatar.png', mimeType: 'image/png', buffer: PNG_1X1 });
    await expect(page.getByText('Đã cập nhật ảnh đại diện')).toBeVisible();

    await page.reload();
    await expect(page.getByLabel('Tên hiển thị')).toHaveValue('Hoàng Thị Tuyết');
    await expect(page.getByLabel('Giới thiệu')).toHaveValue('Tôi làm video giáo dục.');
    await expect(page.getByRole('button', { name: 'Gỡ ảnh' })).toBeVisible();
  });

  test('User thường vào khu vực quản trị nhận 404', async ({ page, request }) => {
    const user = uniqueUser('nonadmin');
    await registerViaApi(request, user);
    await loginViaUi(page, user);
    const res = await page.goto('/admin/users');
    expect(res?.status()).toBe(404);
  });

  test('Administrator khóa User → User không đăng nhập được; mở khóa thì dùng lại được', async ({ page, request, browser }) => {
    const target = uniqueUser('ban');
    await registerViaApi(request, target);

    await loginViaUi(page, E2E_ADMIN);
    await expect(page).toHaveURL(/\/projects/);
    await page.goto('/admin/users');
    await page.getByPlaceholder('Tìm theo email hoặc tên…').fill(target.email);
    const row = page.getByRole('row').filter({ hasText: target.email });
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: 'Khóa' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Khóa' }).click();
    await expect(row.getByText('Đã khóa')).toBeVisible();

    // User bị khóa không đăng nhập được
    const other = await browser.newContext();
    const p2 = await other.newPage();
    await loginViaUi(p2, target, { expectSuccess: false });
    await expect(formAlert(p2)).toBeVisible();
    await expect(p2).toHaveURL(/\/login/);

    // Mở khóa
    await row.getByRole('button', { name: 'Mở khóa' }).click();
    await expect(row.getByText('Đang hoạt động')).toBeVisible();
    await loginViaUi(p2, target);
    await expect(p2).toHaveURL(/\/projects/);
    await other.close();
  });
});
