import { startMockProvider, type MockProvider } from '../../mock-provider/server';
import { expect, registerViaApi, test, uniqueUser } from './fixtures';
import { createProject, uploadSampleSrt, uploadScript } from './helpers';
import { expectNoHorizontalScroll, fixture, openOverlay, overlayJobs, overlayProject, usedBytes, waitOverlay } from './overlay-helpers';

/** Spec 005, US1 và US5 qua ĐƯỜNG THẬT: web, worker, tiến trình dựng hình và ffmpeg. */
let mock: MockProvider;

test.beforeAll(async () => {
  mock = await startMockProvider();
});
test.afterAll(async () => {
  await mock.close();
});

test.describe('xuất video overlay từ voice của Project (US1)', () => {
  test('chọn sẵn nguồn → xuất → rời trang → theo dõi → nhật ký → tải .mp4 → xóa trả dung lượng @mobile', async ({ page }) => {
    const p = await overlayProject(page, mock);
    await uploadScript(page, p.id, ['Xin chào.'], 'thuong.txt');
    await openOverlay(page, p.id);
    await expectNoHorizontalScroll(page);

    // Voice mới nhất và đúng tệp .srt của nó được chọn sẵn; tệp không có mốc bị khóa kèm lời giải thích
    await expect(page.getByRole('combobox', { name: 'Phụ đề (.srt)' })).toContainText('sample-10s.srt');
    await page.getByRole('combobox', { name: 'Phụ đề (.srt)' }).click();
    await expect(page.getByRole('option', { name: /thuong\.txt \(không có mốc thời gian\)/ })).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('overlay-duration')).not.toHaveText('—');
    await expect(page.getByTestId('overlay-estimate')).toContainText('~');
    await expect(page.getByText('Số liệu là ước tính')).toBeVisible();

    const before = await usedBytes(page, p.id);
    await page.getByRole('button', { name: 'Xuất Video Overlay' }).click();
    await expect(page.getByText('Đã đưa vào hàng đợi xuất video').first()).toBeVisible();
    // Rời trang rồi quay lại: tiến trình vẫn chạy
    await page.goto('/projects');
    await waitOverlay(page, p.id, 0, /^completed$/);
    await openOverlay(page, p.id);
    const row = page.getByRole('row').filter({ hasText: 'sample-10s.srt' });
    await expect(row.getByText('Hoàn tất')).toBeVisible();
    await expect(row.getByText('100%')).toBeVisible();
    await expect(page.getByRole('tab', { name: /Video Overlay \(1\)/ })).toBeVisible();

    await row.getByRole('button', { name: 'Nhật ký' }).click();
    const log = page.getByRole('dialog').getByRole('log');
    await expect(log).toContainText('Bắt đầu xuất video 1080×1920');
    await expect(log).toContainText('Hoàn tất xuất video');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toBeHidden();

    const [download] = await Promise.all([page.waitForEvent('download'), row.getByRole('link', { name: 'Tải về' }).click()]);
    expect(download.suggestedFilename()).toBe('sample-10s-overlay.mp4');
    const chunks: Buffer[] = [];
    for await (const c of await download.createReadStream()) chunks.push(c as Buffer);
    const bytes = Buffer.concat(chunks);
    expect(bytes.subarray(4, 8).toString('latin1')).toBe('ftyp');
    const [job] = await overlayJobs(page, p.id);
    expect(bytes.length).toBe(job!.sizeBytes);
    expect(await usedBytes(page, p.id)).toBe(before + bytes.length);
    await expectNoHorizontalScroll(page);

    await row.getByRole('button', { name: 'Xóa', exact: true }).click();
    const confirm = page.getByRole('alertdialog');
    await expect(confirm).toContainText('1 lần xuất, trả lại');
    await confirm.getByRole('button', { name: 'Xóa' }).click();
    await expect(page.getByText('Chưa xuất video nào')).toBeVisible();
    expect(await usedBytes(page, p.id)).toBe(before);
  });

  test('Project chưa có nguồn: trạng thái rỗng có lối tắt; nút xuất bị khóa', async ({ page }) => {
    const user = uniqueUser('overlayempty');
    await registerViaApi(page.request, user);
    const project = await createProject(page, 'Trống');
    await openOverlay(page, project.id, { preview: false });
    await expect(page.getByText('Chưa có phụ đề hoặc voice để tạo video')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Xuất Video Overlay' })).toBeDisabled();
    await page.getByRole('button', { name: 'Mở tab Kịch bản' }).click();
    await expect(page.getByRole('tab', { name: /Kịch bản/ })).toHaveAttribute('data-state', 'active');

    // Có kịch bản thì lối tắt mở hộp thoại tạo voice
    await uploadSampleSrt(page, project.id);
    await openOverlay(page, project.id, { preview: false });
    await page.getByRole('button', { name: 'Tạo voice', exact: true }).click();
    await expect(page.getByRole('dialog').getByRole('button', { name: 'Bắt đầu tạo voice' })).toBeVisible();
  });
});

test.describe('tệp tải lên từ máy (US5)', () => {
  test('Project trống: tải âm thanh và .srt → xem trước → xuất → xóa tệp âm thanh @mobile', async ({ page }) => {
    const user = uniqueUser('overlayup');
    await registerViaApi(page.request, user);
    const project = await createProject(page, 'Tệp ngoài');
    await openOverlay(page, project.id, { preview: false });

    const audioInput = page.locator('input[type=file][accept=".mp3,.wav,.m4a"]');
    const srtInput = page.locator('input[type=file][accept=".srt"]');
    // chưa có kịch bản thì không mời tạo voice
    await expect(page.getByRole('button', { name: 'Tạo voice', exact: true })).toHaveCount(0);
    await audioInput.setInputFiles({ name: 'sai.ogg', mimeType: 'audio/ogg', buffer: Buffer.from('x') });
    await expect(page.getByText('Chỉ nhận tệp .mp3, .wav hoặc .m4a.')).toBeVisible();
    await srtInput.setInputFiles({ name: 'sai.txt', mimeType: 'text/plain', buffer: Buffer.from('x') });
    await expect(page.getByText('Chỉ nhận tệp .srt.')).toBeVisible();

    await audioInput.setInputFiles({ name: 'giong-ngoai.mp3', mimeType: 'audio/mpeg', buffer: fixture('sample-10s.mp3') });
    const item = page.getByTestId('overlay-audio-item');
    await expect(item.getByText('Sẵn sàng')).toBeVisible({ timeout: 30_000 });
    await expect(item).toContainText('0:10');
    await srtInput.setInputFiles({ name: 'khong-moc.srt', mimeType: 'application/x-subrip', buffer: Buffer.from('Xin chào các bạn.\nHẹn gặp lại.', 'utf8') });
    await expect(page.getByText('không có mốc thời gian hợp lệ nên không dùng làm phụ đề được')).toBeVisible();
    await srtInput.setInputFiles({ name: 'phu-de.srt', mimeType: 'application/x-subrip', buffer: fixture('sample-10s.srt') });
    await expect(page.getByRole('combobox', { name: 'Phụ đề (.srt)' })).toContainText('phu-de.srt');
    await expect(page.getByRole('combobox', { name: 'Voice', exact: true })).toContainText('giong-ngoai.mp3');
    await expect(page.getByTestId('overlay-canvas')).toHaveAttribute('data-fonts', 'ready');
    await expect(page.getByTestId('overlay-duration')).toHaveText('0:10');
    await expectNoHorizontalScroll(page);

    await page.getByRole('button', { name: 'Xuất Video Overlay' }).click();
    await waitOverlay(page, project.id, 0, /^completed$/);

    await item.getByRole('button', { name: /^Xóa: giong-ngoai\.mp3/ }).click();
    const confirm = page.getByRole('alertdialog');
    await expect(confirm).toContainText('giong-ngoai.mp3');
    await expect(confirm).toContainText(/1 tệp âm thanh, trả lại [\d.]+ KB/);
    await confirm.getByRole('button', { name: 'Xóa' }).click();
    await expect(item).toHaveCount(0);
    await expect(page.getByRole('row').filter({ hasText: 'phu-de.srt' }).getByRole('link', { name: 'Tải về' })).toBeVisible();
  });
});
