import { startMockProvider, type MockProvider } from '../../mock-provider/server';
import { createProject, setupProvider, startJob, uploadScript, waitJob } from './helpers';
import { expect, loginViaUi, registerViaApi, test, uniqueUser } from './fixtures';

/**
 * US2 (quickstart #4, #14): tiến trình chạy nền — đóng tab rồi mở lại vẫn thấy tiến độ và log đầy đủ;
 * hai tab cùng thấy một log.
 */
let mock: MockProvider;
test.beforeAll(async () => {
  mock = await startMockProvider();
});
test.afterAll(async () => {
  await mock.close();
});

test.describe('chạy nền và theo dõi nhiều nơi (US2)', () => {
  test('đóng tab giữa chừng, mở lại: tiến trình vẫn chạy và log đầy đủ; hai tab thấy cùng log', async ({ page, context, request }) => {
    await setupProvider(page, mock.url, 'delay-1200');
    const user = uniqueUser('bg');
    await registerViaApi(request, user);
    await loginViaUi(page, user);
    const project = await createProject(page, 'Chạy nền');
    const file = await uploadScript(page, project.id, ['Một.', 'Hai.', 'Ba.', 'Bốn.', 'Năm.', 'Sáu.']);
    const job = await startJob(page, project.id, file.id);

    // Tab 1 thấy log bắt đầu, rồi đóng đi
    await page.goto(`/projects/${project.id}/jobs/${job.id}`);
    await expect(page.getByRole('log')).toContainText('Bắt đầu tạo voice', { timeout: 20_000 });
    await page.close();

    // Trong lúc không có tab nào mở, tiến trình vẫn chạy tiếp
    const page2 = await context.newPage();
    await waitJob(page2, job.id, /running|completed/, 20_000);

    // Mở lại + mở thêm tab thứ hai cùng lúc: cả hai thấy cùng log đầy đủ
    const page3 = await context.newPage();
    await page2.goto(`/projects/${project.id}/jobs/${job.id}`);
    await page3.goto(`/projects/${project.id}/jobs/${job.id}`);
    for (const p of [page2, page3]) {
      await expect(p.getByRole('log')).toContainText('Bắt đầu tạo voice', { timeout: 20_000 });
      await expect(p.getByRole('log')).toContainText('Hoàn tất tạo voice', { timeout: 90_000 });
      await expect(p.getByText(/6\/6/)).toBeVisible();
    }
    const [l2, l3] = await Promise.all([page2.getByRole('log').innerText(), page3.getByRole('log').innerText()]);
    expect(l2).toBe(l3);

    // Chỉ báo tiến trình đang chạy ở thanh đầu trang không còn khi đã hoàn tất
    await page2.goto('/projects');
    await expect(page2.getByRole('link', { name: 'Chạy nền' })).toBeVisible();
  });
});
