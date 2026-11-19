import { createProject } from './helpers';
import { expect, loginViaUi, registerViaApi, test, uniqueUser } from './fixtures';

/** US6 (quickstart #8): tìm kiếm không dấu, sắp xếp, lọc, trạng thái "không tìm thấy" và xóa bộ lọc. */
test.describe('tìm kiếm, sắp xếp, lọc Project (US6)', () => {
  test('tìm không dấu, không tìm thấy → xóa bộ lọc, sắp xếp theo tên, giữ bộ lọc khi tải lại @mobile', async ({ page, request }) => {
    const user = uniqueUser('search');
    await registerViaApi(request, user);
    await loginViaUi(page, user);
    await createProject(page, 'Lịch sử Việt Nam', 'Các video về lịch sử');
    await createProject(page, 'Đồ ăn đường phố');
    await createProject(page, 'Âm nhạc dân gian');
    await page.goto('/projects');
    await expect(page.getByRole('link', { name: 'Lịch sử Việt Nam' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Đồ ăn đường phố' })).toBeVisible();

    const search = page.getByLabel('Tìm kiếm');
    // gõ không dấu vẫn tìm thấy tên có dấu
    await search.fill('lich su');
    await expect(page).toHaveURL(/q=lich\+su|q=lich%20su/);
    await expect(page.getByRole('link', { name: 'Lịch sử Việt Nam' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Đồ ăn đường phố' })).toBeHidden();

    // đ ↔ d
    await search.fill('do an');
    await expect(page.getByRole('link', { name: 'Đồ ăn đường phố' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Lịch sử Việt Nam' })).toBeHidden();

    // khớp cả mô tả
    await search.fill('video');
    await expect(page.getByRole('link', { name: 'Lịch sử Việt Nam' })).toBeVisible();

    // không tìm thấy → trạng thái rõ ràng + xóa bộ lọc
    await search.fill('khong-co-gi-ca-xyz');
    await expect(page.getByText('Không tìm thấy kết quả')).toBeVisible();
    await page.getByRole('button', { name: 'Xóa bộ lọc' }).last().click();
    await expect(page.getByRole('link', { name: 'Âm nhạc dân gian' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Đồ ăn đường phố' })).toBeVisible();
    await expect(page).not.toHaveURL(/q=/);
  });

  test('sắp xếp theo tên tăng dần, lọc theo trạng thái "chưa có tiến trình", URL giữ lại khi tải lại', async ({ page, request }) => {
    const user = uniqueUser('sort');
    await registerViaApi(request, user);
    await loginViaUi(page, user);
    await createProject(page, 'Bravo');
    await createProject(page, 'Alpha');
    await createProject(page, 'Charlie');

    await page.goto('/projects?sort=name&order=asc');
    const names = page.locator('tbody tr td a');
    await expect(names).toHaveText(['Alpha', 'Bravo', 'Charlie']);

    await page.goto('/projects?sort=name&order=desc');
    await expect(names).toHaveText(['Charlie', 'Bravo', 'Alpha']);

    await page.goto('/projects?jobState=running');
    await expect(page.getByText('Không tìm thấy kết quả')).toBeVisible();

    await page.goto('/projects?jobState=none&sort=name&order=asc');
    await expect(names).toHaveText(['Alpha', 'Bravo', 'Charlie']);
    await page.reload();
    await expect(names).toHaveText(['Alpha', 'Bravo', 'Charlie']);
  });
});
