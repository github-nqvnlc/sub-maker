import type { Page } from '@playwright/test';
import { startMockProvider, type MockProvider } from '../../mock-provider/server';
import { expect, test } from './fixtures';
import { expectNoHorizontalScroll } from './overlay-helpers';
import { jobRow, makeVideoFile, openVideoTab, startUpload, videoProject, waitVideoJob } from './video-helpers';

/** Spec 006, US5 (T108, quickstart §5): dán từ điển có dòng lỗi và dòng trùng, việc mới nhận từ điển, "Dịch lại" phải xác nhận. */
let mock: MockProvider;
test.beforeAll(async () => {
  mock = await startMockProvider();
});
test.afterAll(async () => {
  await mock.close();
});

const transcriptions = () => mock.sonioxRequests.filter((r) => r.method === 'POST' && r.path === '/v1/transcriptions').map((r) => JSON.parse(r.body) as { context?: { translation_terms: Array<{ source: string; target: string }> } });
const count = (page: Page) => page.getByTestId('glossary-count');

const PASTED = [
  'Sub Maker -> Sub Maker',
  'teacher -> thầy giáo',
  'everyone,mọi người',
  'today -> hôm nay',
  'thiếu vế',
  'lesson -> bài học',
  'class -> lớp',
  'TEACHER -> cô giáo',
  'new -> mới',
  'thank you -> cảm ơn',
].join('\n');

test('Independent Test US5: dán 10 dòng, thêm sửa xóa, việc mới nhận từ điển, dịch lại có xác nhận @mobile', async ({ page }) => {
  test.setTimeout(180_000);
  const p = await videoProject(page, mock);
  await openVideoTab(page, p.id);

  // 10 dòng: một dòng thiếu vế, một dòng trùng từ gốc; tám dòng hợp lệ được thêm
  await page.getByRole('textbox', { name: 'Dán nhiều cặp' }).fill(PASTED);
  await page.getByRole('button', { name: 'Thêm các dòng' }).click();
  await expect(count(page)).toContainText('8/200 cặp');
  const errors = page.getByTestId('glossary-line-errors');
  await expect(errors).toContainText('Dòng 1: thiếu từ gốc hoặc từ dịch');
  await expect(errors).toContainText('Dòng 2: từ gốc đã có');
  await expect(page.getByRole('textbox', { name: 'Dán nhiều cặp' })).toHaveValue('thiếu vế\nTEACHER -> cô giáo');
  await expect(page.getByRole('row').filter({ hasText: 'Sub Maker' }).getByText('Giữ nguyên không dịch')).toBeVisible();

  // thêm một cặp trùng thì báo đúng lý do; thêm cặp mới, sửa, rồi xóa có xác nhận
  await page.getByRole('textbox', { name: 'Từ gốc' }).fill('Today');
  await page.getByRole('textbox', { name: 'Từ dịch' }).fill('nay');
  await page.getByRole('button', { name: 'Thêm cặp' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'từ gốc đã có' }).first()).toBeVisible();
  await page.getByRole('textbox', { name: 'Từ gốc' }).fill('student');
  await page.getByRole('textbox', { name: 'Từ dịch' }).fill('học trò');
  await page.getByRole('button', { name: 'Thêm cặp' }).click();
  await expect(count(page)).toContainText('9/200 cặp');
  await expect(page.getByRole('textbox', { name: 'Từ gốc' })).toHaveValue('');

  await page.getByRole('button', { name: 'Sửa cặp student' }).click();
  const editRow = page.getByRole('row').filter({ has: page.getByRole('button', { name: 'Lưu', exact: true }) });
  await editRow.getByRole('textbox', { name: 'Từ dịch' }).fill('học sinh');
  await editRow.getByRole('button', { name: 'Lưu', exact: true }).click();
  await expect(page.getByRole('row').filter({ hasText: 'học sinh' })).toBeVisible();

  await page.getByRole('button', { name: 'Xóa cặp class' }).click();
  await expect(page.getByRole('alertdialog')).toContainText('class → lớp');
  await expect(page.getByRole('alertdialog')).toContainText('Xóa 1 cặp');
  await page.getByRole('alertdialog').getByRole('button', { name: 'Xóa' }).click();
  await expect(count(page)).toContainText('8/200 cặp');
  await expectNoHorizontalScroll(page);

  // còn nguyên sau khi tải lại trang
  await openVideoTab(page, p.id);
  await expect(count(page)).toContainText('8/200 cặp');

  // việc mới trong Project gửi kèm từ điển đã lưu
  const source = makeVideoFile('tu-dien.mp4');
  await startUpload(page, source);
  await waitVideoJob(page, p.id, 'review_ready', 120_000);
  const first = transcriptions().at(-1)!.context!.translation_terms;
  expect(first).toHaveLength(8);
  expect(first).toContainEqual({ source: 'Sub Maker', target: 'Sub Maker' });
  expect(first).toContainEqual({ source: 'student', target: 'học sinh' });

  await jobRow(page, source.name).getByRole('link', { name: 'Mở' }).click();
  await expect(page.getByTestId('cue-row')).toHaveCount(3);
  const target = page.getByRole('textbox', { name: 'Bản dịch đoạn 1' });
  const translated = await target.inputValue();
  await target.fill('Câu đã sửa tay');
  await expect(page.getByTestId('save-status')).toHaveText('Đã lưu');

  // đổi từ điển trong trình biên tập
  await page.getByRole('tab', { name: 'Từ điển' }).click();
  await expect(count(page)).toContainText('8/200 cặp');
  await page.getByRole('textbox', { name: 'Từ gốc' }).fill('hello');
  await page.getByRole('textbox', { name: 'Từ dịch' }).fill('xin chào');
  await page.getByRole('button', { name: 'Thêm cặp' }).click();
  await expect(count(page)).toContainText('9/200 cặp');

  // dịch lại: nêu thời lượng, chi phí và hậu quả; hủy thì không gọi nhà cung cấp
  await page.getByRole('tab', { name: /^Phụ đề/ }).click();
  const before = transcriptions().length;
  await page.getByRole('button', { name: 'Dịch lại', exact: true }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog.getByTestId('retranslate-duration')).toContainText('0:0');
  await expect(dialog.getByTestId('retranslate-cost')).toBeVisible();
  await expect(dialog).toContainText('gồm cả các đoạn bạn đã sửa tay');
  await dialog.getByRole('button', { name: 'Hủy' }).click();
  await expect(dialog).toBeHidden();
  expect(transcriptions()).toHaveLength(before);
  await expect(target).toHaveValue('Câu đã sửa tay');

  await page.getByRole('button', { name: 'Dịch lại', exact: true }).click();
  await dialog.getByRole('button', { name: 'Dịch lại', exact: true }).click();
  await expect(page.getByText('Đã đưa vào hàng đợi dịch lại')).toBeVisible();
  await waitVideoJob(page, p.id, 'review_ready', 120_000);
  await expect(page.getByRole('textbox', { name: 'Bản dịch đoạn 1' })).toHaveValue(translated, { timeout: 30_000 });
  expect(transcriptions()).toHaveLength(before + 1);
  const second = transcriptions().at(-1)!.context!.translation_terms;
  expect(second).toHaveLength(9);
  expect(second).toContainEqual({ source: 'hello', target: 'xin chào' });
});
