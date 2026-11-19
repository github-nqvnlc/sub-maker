import { startMockProvider, type MockProvider } from '../../mock-provider/server';
import { createProject, setupProvider, startJob, uploadScript, waitJob } from './helpers';
import { E2E_ADMIN, expect, loginViaUi, registerViaApi, test, uniqueUser } from './fixtures';

/** US8 (quickstart #11): Dashboard cá nhân, thống kê Administrator, cài đặt hệ thống; User thường vào trang Admin nhận 404. */
let mock: MockProvider;
test.beforeAll(async () => {
  mock = await startMockProvider();
});
test.afterAll(async () => {
  await mock.close();
});

const LINES = ['Xin chào các bạn.', 'Hôm nay học bài mới.', 'Cảm ơn đã theo dõi.'];
const CHARS = LINES.reduce((n, l) => n + [...l].length, 0);

test.describe('Dashboard và thống kê (US8)', () => {
  test('Dashboard cá nhân khớp dữ liệu; Admin thấy số liệu từng User; User thường không vào được trang Admin @mobile', async ({ page, request, browser }) => {
    await setupProvider(page, mock.url, 'ok');
    const user = uniqueUser('dash');
    await registerViaApi(request, user);
    await loginViaUi(page, user);

    // Trước khi có dữ liệu: số 0, chi phí/token không bịa số
    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: 'Thống kê của tôi' })).toBeVisible();
    await expect(page.getByTestId('stat-voices')).toHaveText('0');
    await expect(page.getByTestId('stat-cost')).toHaveText('Chưa cấu hình giá');
    await expect(page.getByTestId('stat-tokens')).toHaveText('Nhà cung cấp không trả về');
    await expect(page.getByText('Chưa có lần gọi AI nào trong khoảng này.').first()).toBeVisible();

    // Tạo 1 voice thật qua worker
    const project = await createProject(page, 'Dự án thống kê');
    const file = await uploadScript(page, project.id, LINES);
    const job = await startJob(page, project.id, file.id);
    await waitJob(page, job.id, 'completed', 60_000);

    await page.goto('/dashboard');
    await expect(page.getByTestId('stat-projects')).toHaveText('1');
    await expect(page.getByTestId('stat-voices')).toHaveText('1');
    await expect(page.getByTestId('stat-chars')).toHaveText(CHARS.toLocaleString('vi-VN'));
    await expect(page.getByTestId('stat-storage')).toContainText('trên 500.0 MB');
    await expect(page.getByRole('cell', { name: 'Chung của hệ thống' })).toBeVisible();
    await expect(page.getByText('Hoàn tất').first()).toBeVisible();

    // Bộ lọc khoảng ngày: chọn một khoảng trong quá khứ xa → không có mức dùng
    await page.getByLabel('Từ ngày').fill('2020-01-01');
    await page.getByLabel('Đến ngày').fill('2020-01-31');
    await page.getByRole('button', { name: 'Áp dụng' }).click();
    await expect(page.getByTestId('stat-chars')).toHaveText('0');
    await expect(page.getByTestId('stat-voices')).toHaveText('1'); // số voice không phụ thuộc khoảng ngày

    // User thường không vào được khu Admin (404, không lộ chức năng)
    for (const path of ['/admin/stats', '/admin/settings']) {
      const res = await page.goto(path);
      expect(res?.status()).toBe(404);
    }
    expect((await page.request.get('/api/admin/stats')).status()).toBe(404);

    // Administrator thấy hàng của User này với số liệu khớp
    const adminCtx = await browser.newContext({ baseURL: page.url().split('/').slice(0, 3).join('/') });
    const adminPage = await adminCtx.newPage();
    await loginViaUi(adminPage, E2E_ADMIN);
    await adminPage.goto('/admin/stats');
    await expect(adminPage.getByRole('heading', { name: 'Thống kê hệ thống' })).toBeVisible();
    const row = adminPage.getByTestId('admin-stat-row').filter({ hasText: user.email });
    await expect(row).toBeVisible();
    await expect(row).toContainText(CHARS.toLocaleString('vi-VN'));
    await expect(adminPage.getByTestId('admin-stat-users')).not.toHaveText('0');
    await adminCtx.close();
  });

  test('Admin đổi giới hạn tệp trong trang Cài đặt hệ thống: có hiệu lực ngay, giá trị sai bị chặn', async ({ browser, page, request }) => {
    const user = uniqueUser('limit');
    await registerViaApi(request, user);
    await loginViaUi(page, user);
    const project = await createProject(page, 'Thử giới hạn');

    const adminCtx = await browser.newContext({ baseURL: page.url().split('/').slice(0, 3).join('/') });
    const admin = await adminCtx.newPage();
    await loginViaUi(admin, E2E_ADMIN);
    await admin.goto('/admin/settings');
    const field = admin.getByLabel('Kích thước tối đa mỗi tệp kịch bản (MB)');
    await expect(field).toHaveValue('2');

    // Giá trị sai: nút Lưu bị khóa và có thông báo
    await field.fill('0');
    await expect(admin.getByText('Giá trị chưa hợp lệ')).toBeVisible();
    await expect(admin.getByRole('button', { name: 'Lưu cài đặt' })).toBeDisabled();

    try {
      await field.fill('0.001'); // ~1 KB
      await admin.getByRole('button', { name: 'Lưu cài đặt' }).click();
      await expect(admin.getByText('Đã lưu cài đặt')).toBeVisible();

      const big = Buffer.from('Câu dài để vượt giới hạn rất nhỏ. '.repeat(100), 'utf8');
      const res = await page.request.post(`/api/projects/${project.id}/files`, {
        multipart: { file: { name: 'lon.txt', mimeType: 'text/plain', buffer: big } },
        headers: { Origin: new URL(page.url()).origin },
      });
      expect(res.status()).toBe(413);
    } finally {
      // trả về mặc định để không ảnh hưởng các kịch bản khác
      await admin.goto('/admin/settings');
      await admin.getByLabel('Kích thước tối đa mỗi tệp kịch bản (MB)').fill('2');
      await admin.getByRole('button', { name: 'Lưu cài đặt' }).click();
      await expect(admin.getByText('Đã lưu cài đặt')).toBeVisible();
      await adminCtx.close();
    }
  });
});
