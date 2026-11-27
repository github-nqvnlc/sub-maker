import { startMockProvider, type MockProvider } from '../../mock-provider/server';
import { createProject, jobStatus, setupProvider, startJob, uploadScript, waitJob } from './helpers';
import { expect, loginViaUi, registerViaApi, test, uniqueUser } from './fixtures';

/**
 * US4 (quickstart #6, #7): dừng, sửa thiết lập, tiếp tục, chạy lại, xóa tiến trình — qua giao diện,
 * trên đường thật web → pg-boss → worker → nhà cung cấp giả (có độ trễ để kịp dừng giữa chừng).
 */
let mock: MockProvider;
test.beforeAll(async () => {
  mock = await startMockProvider();
});
test.afterAll(async () => {
  await mock.close();
});

const LINES = ['Câu thứ nhất.', 'Câu thứ hai.', 'Câu thứ ba.', 'Câu thứ tư.', 'Câu thứ năm.', 'Câu thứ sáu.'];

test.describe('quản lý tiến trình (US4)', () => {
  test('dừng giữa chừng → sửa thiết lập → tiếp tục tới khi hoàn tất → chạy lại → xóa', async ({ page, request }) => {
    await setupProvider(page, mock.url, 'delay-2500');
    const user = uniqueUser('jobs');
    await registerViaApi(request, user);
    await loginViaUi(page, user);
    const project = await createProject(page, 'Quản lý tiến trình');
    const file = await uploadScript(page, project.id, LINES);
    const job = await startJob(page, project.id, file.id);
    await waitJob(page, job.id, /running/, 20_000);

    await page.goto(`/projects/${project.id}`);
    await page.getByRole('tab', { name: /Tiến trình/ }).click();

    // 1) Dừng
    await page.getByRole('button', { name: 'Dừng', exact: true }).click();
    await expect.poll(() => jobStatus(page, job.id), { timeout: 40_000, intervals: [400] }).toBe('stopped');
    await expect(page.getByText('Đã dừng').first()).toBeVisible({ timeout: 10_000 });
    // Tiến trình đã dừng: không còn nút Dừng, có Tiếp tục / Sửa thiết lập
    await expect(page.getByRole('button', { name: 'Dừng', exact: true })).toBeHidden();

    // 2) Sửa thiết lập (chọn giọng khác)
    await page.getByRole('button', { name: 'Sửa thiết lập' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('Sửa thiết lập tiến trình')).toBeVisible();
    await dialog.getByRole('combobox', { name: 'Giọng đọc' }).click();
    await page.getByRole('option').nth(1).click();
    await dialog.getByRole('button', { name: 'Lưu thiết lập' }).click();
    await expect(dialog).toBeHidden();
    const detail = await (await page.request.get(`/api/jobs/${job.id}`)).json();
    expect(detail.settings.voice).not.toBe('banmai');
    expect(detail.status).toBe('stopped');

    // 3) Tiếp tục → hoàn tất
    await page.getByRole('button', { name: 'Tiếp tục' }).click();
    await waitJob(page, job.id, 'completed', 90_000);
    await expect(page.getByText('Hoàn tất').first()).toBeVisible({ timeout: 10_000 });
    // Tiến trình đã hoàn tất: không sửa được thiết lập, nhưng chạy lại được
    await expect(page.getByRole('button', { name: 'Sửa thiết lập' })).toBeHidden();

    // 4) Chạy lại → tiến trình MỚI
    await page.getByRole('button', { name: 'Chạy lại' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Chạy lại' }).click();
    await expect(page.getByRole('dialog')).toBeHidden();
    await expect.poll(async () => (await (await page.request.get(`/api/projects/${project.id}`)).json()).jobs.length, { timeout: 15_000 }).toBe(2);
    const jobs: { id: string; status: string }[] = (await (await page.request.get(`/api/projects/${project.id}`)).json()).jobs;
    const rerun = jobs.find((j) => j.id !== job.id)!;
    // Chạy lại xong thì giao diện mở trang theo dõi của tiến trình mới
    await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/jobs/${rerun.id}$`));
    await waitJob(page, rerun.id, 'completed', 90_000);

    // 5) Xóa một tiến trình: hộp xác nhận nêu hậu quả; hủy thì giữ, xác nhận thì mất
    await page.getByRole('link', { name: 'Về Project' }).click();
    await page.getByRole('tab', { name: /Tiến trình/ }).click();
    const rows = page.locator('tbody tr');
    await expect(rows).toHaveCount(2);
    await rows.first().getByRole('button', { name: 'Xóa', exact: true }).click();
    const confirm = page.getByRole('alertdialog');
    await expect(confirm).toContainText('1 tiến trình');
    await expect(confirm).toContainText('voice');
    await confirm.getByRole('button', { name: 'Hủy' }).click();
    await expect(rows).toHaveCount(2);

    await rows.first().getByRole('button', { name: 'Xóa', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Xóa', exact: true }).click();
    await expect(rows).toHaveCount(1);
  });

  test('xóa nhiều tiến trình cùng lúc, kể cả tiến trình đang chạy (dừng rồi xóa)', async ({ page, request }) => {
    await setupProvider(page, mock.url, 'delay-2500');
    const user = uniqueUser('jobsN');
    await registerViaApi(request, user);
    await loginViaUi(page, user);
    const project = await createProject(page, 'Xóa nhiều tiến trình');
    const file = await uploadScript(page, project.id, LINES);
    const j1 = await startJob(page, project.id, file.id);
    await waitJob(page, j1.id, /running/, 20_000);

    await page.goto(`/projects/${project.id}`);
    await page.getByRole('tab', { name: /Tiến trình/ }).click();
    await page.getByRole('checkbox', { name: 'Chọn tất cả' }).check();
    await page.getByRole('button', { name: 'Xóa đã chọn' }).click();
    const confirm = page.getByRole('alertdialog');
    await expect(confirm).toContainText('tiến trình');
    await expect(confirm).toContainText('dừng');
    await confirm.getByRole('button', { name: 'Xóa', exact: true }).click();

    await expect(page.getByText('Chưa có tiến trình nào.')).toBeVisible({ timeout: 40_000 });
    expect((await page.request.get(`/api/jobs/${j1.id}`)).status()).toBe(404);
  });
});
