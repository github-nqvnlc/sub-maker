import { startMockProvider, type MockProvider } from '../../mock-provider/server';
import { expect, formAlert, registerViaApi, test, uniqueUser } from './fixtures';
import { createProject, setupProvider, uploadSampleSrt, waitJob } from './helpers';

/**
 * Spec 003, US1 qua ĐƯỜNG THẬT: tải .srt → xem trước cue (không số thứ tự/mốc trong chữ) → ước tính → tạo voice khớp mốc
 * → theo dõi → nghe và bôi theo đoạn. Dữ liệu thử CHỈ dùng 3 cue đầu của tệp mẫu (≤ 10 giây).
 */
let mock: MockProvider;

test.beforeAll(async () => {
  mock = await startMockProvider();
});
test.afterAll(async () => {
  await mock.close();
});

test.describe('voice khớp mốc thời gian phụ đề (spec 003, US1)', () => {
  test('tải .srt → xem cue → ước tính → tạo voice khớp mốc → nghe voice @mobile', async ({ page }) => {
    await setupProvider(page, mock.url, 'ms-60');
    const user = uniqueUser('timed');
    await registerViaApi(page.request, user);
    const project = await createProject(page, 'Phụ đề khớp mốc');

    await page.goto(`/projects/${project.id}`);
    await page.getByLabel('Tải kịch bản lên').setInputFiles({
      name: 'sample-10s.srt',
      mimeType: 'application/x-subrip',
      buffer: (await import('node:fs')).readFileSync('tests/fixtures/sample-10s.srt'),
    });

    // Xem trước: tab cue có mốc thời gian, chữ đọc không còn số thứ tự/mốc
    const preview = page.getByRole('dialog');
    await preview.getByRole('tab', { name: 'Cue và mốc thời gian' }).click();
    await expect(preview.getByText(/3 cue/)).toBeVisible();
    await expect(preview.getByText('Không Putin.')).toBeVisible();
    await expect(preview.getByText('00:00,300 → 00:04,675')).toBeVisible();
    await expect(preview.getByText('-->')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toBeHidden();

    // Hộp thoại tạo voice: chế độ khớp mốc bật sẵn, có ước tính theo ký tự đọc thực
    await page.getByRole('button', { name: 'Tạo voice' }).first().click();
    const dlg = page.getByRole('dialog');
    await expect(dlg.getByLabel('Khớp mốc thời gian phụ đề')).toBeChecked();
    await expect(dlg.getByLabel('Ghép cue cùng câu')).toBeChecked();
    const estimate = dlg.getByRole('region', { name: 'Ước tính trước khi tạo' });
    await expect(estimate).toContainText('122'); // 60 + 50 + 12 ký tự đọc
    await expect(estimate).toContainText('Chưa cấu hình đơn giá');
    await dlg.getByRole('button', { name: 'Bắt đầu tạo voice' }).click();

    // Theo dõi tới khi hoàn tất; huy hiệu chế độ và log đơn vị đọc
    await expect(page).toHaveURL(/\/jobs\/[0-9a-f-]{36}$/);
    const jobId = page.url().split('/').pop()!;
    await waitJob(page, jobId, 'completed');
    await expect(page.getByText('Khớp mốc', { exact: true })).toBeVisible();
    await expect(page.getByRole('log')).toContainText('ghép thành 3 đoạn đọc');

    // Nghe voice: văn bản đồng bộ có đủ 3 đoạn
    await page.getByRole('link', { name: 'Nghe voice' }).click();
    const synced = page.getByTestId('synced-text');
    await expect(synced.getByRole('listitem')).toHaveCount(3);
    await expect(synced).toContainText('Không Putin.');
  });

  test('tệp .skt bị từ chối: chỉ nhận .txt, .md, .srt', async ({ page }) => {
    await setupProvider(page, mock.url, 'ms-60');
    const user = uniqueUser('timedskt');
    await registerViaApi(page.request, user);
    const project = await createProject(page, 'Tệp cũ .skt');
    await page.goto(`/projects/${project.id}`);
    await page.getByLabel('Tải kịch bản lên').setInputFiles({ name: 'cu.skt', mimeType: 'text/plain', buffer: Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nXin chào.\n', 'utf8') });
    await expect(formAlert(page)).toContainText('.txt, .md, .srt');
  });

  test('tệp .txt không có mốc: tắt chế độ khớp mốc kèm lý do', async ({ page }) => {
    await setupProvider(page, mock.url, 'ms-60');
    const user = uniqueUser('timedtxt');
    await registerViaApi(page.request, user);
    const project = await createProject(page, 'Kịch bản thường');
    await page.goto(`/projects/${project.id}`);
    await page.getByLabel('Tải kịch bản lên').setInputFiles({ name: 'a.txt', mimeType: 'text/plain', buffer: Buffer.from('Xin chào các bạn.\nHẹn gặp lại.', 'utf8') });
    await expect(page.getByRole('dialog').getByText('Xin chào các bạn.')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toBeHidden();
    await page.getByRole('button', { name: 'Tạo voice' }).first().click();
    const dlg = page.getByRole('dialog');
    await expect(dlg.getByLabel('Khớp mốc thời gian phụ đề')).toBeDisabled();
    await expect(dlg).toContainText('không có mốc thời gian hợp lệ');
  });
});

// Dùng lại hàm tải mẫu cho các spec khác
export { uploadSampleSrt };
