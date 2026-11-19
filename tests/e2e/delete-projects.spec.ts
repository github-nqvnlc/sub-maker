import { startMockProvider, type MockProvider } from '../../mock-provider/server';
import { createProject, setupProvider, startJob, uploadScript, waitJob } from './helpers';
import { expect, loginViaUi, registerViaApi, test, uniqueUser } from './fixtures';

/** US5: xóa một/nhiều Project — hộp xác nhận nêu số lượng và hậu quả, hủy thì không xóa. */
let mock: MockProvider;
test.beforeAll(async () => {
  mock = await startMockProvider();
});
test.afterAll(async () => {
  await mock.close();
});

test.describe('xóa Project (US5)', () => {
  test('xóa một Project từ danh sách: hủy thì giữ nguyên, xác nhận thì mất hẳn', async ({ page, request }) => {
    const user = uniqueUser('del1');
    await registerViaApi(request, user);
    await loginViaUi(page, user);
    await createProject(page, 'Dự án cần xóa');
    await createProject(page, 'Dự án giữ lại');
    await page.goto('/projects');

    const row = page.getByRole('row', { name: /Dự án cần xóa/ });
    await row.getByRole('button', { name: 'Xóa Project' }).click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText('1 Project');
    await expect(dialog).toContainText('Dự án cần xóa');
    await expect(dialog).toContainText('không thể khôi phục');

    // Hủy → không xóa
    await dialog.getByRole('button', { name: 'Hủy' }).click();
    await expect(page.getByRole('link', { name: 'Dự án cần xóa' })).toBeVisible();

    // Xác nhận → xóa
    await row.getByRole('button', { name: 'Xóa Project' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Xóa Project' }).click();
    await expect(page.getByRole('link', { name: 'Dự án cần xóa' })).toBeHidden();
    await expect(page.getByRole('link', { name: 'Dự án giữ lại' })).toBeVisible();
  });

  test('chọn nhiều và xóa hàng loạt: hộp xác nhận nêu số lượng', async ({ page, request }) => {
    const user = uniqueUser('delN');
    await registerViaApi(request, user);
    await loginViaUi(page, user);
    for (const n of ['A1', 'B2', 'C3']) await createProject(page, `Hàng loạt ${n}`);
    await page.goto('/projects');

    await page.getByRole('row', { name: /Hàng loạt A1/ }).getByRole('checkbox').check();
    await page.getByRole('row', { name: /Hàng loạt B2/ }).getByRole('checkbox').check();
    await expect(page.getByRole('status').filter({ hasText: 'đã chọn' })).toContainText('2');

    await page.getByRole('button', { name: 'Xóa đã chọn' }).click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText('2 Project');
    await dialog.getByRole('button', { name: 'Xóa Project' }).click();

    await expect(page.getByRole('link', { name: 'Hàng loạt A1' })).toBeHidden();
    await expect(page.getByRole('link', { name: 'Hàng loạt B2' })).toBeHidden();
    await expect(page.getByRole('link', { name: 'Hàng loạt C3' })).toBeVisible();
  });

  test('xóa Project đang có tiến trình chạy: tiến trình bị dừng rồi xóa sạch; trang chi tiết quay về danh sách', async ({ page, request }) => {
    await setupProvider(page, mock.url, 'delay-2500');
    const user = uniqueUser('delRun');
    await registerViaApi(request, user);
    await loginViaUi(page, user);
    const project = await createProject(page, 'Đang chạy rồi xóa');
    const file = await uploadScript(page, project.id, ['Câu một.', 'Câu hai.', 'Câu ba.', 'Câu bốn.']);
    const job = await startJob(page, project.id, file.id);
    await waitJob(page, job.id, /running|queued/, 15_000);

    await page.goto(`/projects/${project.id}`);
    await page.getByRole('button', { name: 'Xóa Project' }).first().click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Xóa Project' }).click();
    await expect(page).toHaveURL(/\/projects$/, { timeout: 40_000 });
    await expect(page.getByRole('link', { name: 'Đang chạy rồi xóa' })).toBeHidden();

    // Tiến trình cũ không còn truy cập được (404), không để lại dữ liệu mồ côi
    expect((await page.request.get(`/api/jobs/${job.id}`)).status()).toBe(404);
    expect((await page.request.get(`/api/projects/${project.id}`)).status()).toBe(404);
  });
});
