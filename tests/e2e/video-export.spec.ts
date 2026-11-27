import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Download, Page } from '@playwright/test';
import { startMockProvider, type MockProvider } from '../../mock-provider/server';
import { expect, test } from './fixtures';
import { expectNoHorizontalScroll } from './overlay-helpers';
import { adminSettings, e2eQuery, jobRow, makeVideoFile, openVideoTab, startUpload, videoProject, waitVideoJob, type VideoFile } from './video-helpers';

/** Spec 006, US3 qua đường thật: xuất bằng ffmpeg thật, tải ba loại tệp, hạn xóa, tải lại video nguồn (FR-037 đến FR-046, FR-054). */
let mock: MockProvider;

test.beforeAll(async () => {
  mock = await startMockProvider();
});
test.afterAll(async () => {
  await mock.close();
});

async function openExport(page: Page, source: VideoFile) {
  const p = await videoProject(page, mock);
  await openVideoTab(page, p.id);
  await startUpload(page, source);
  const job = await waitVideoJob(page, p.id, 'review_ready', 120_000);
  await jobRow(page, source.name).getByRole('link', { name: 'Mở' }).click();
  await expect(page.getByTestId('cue-row')).toHaveCount(3);
  await page.getByRole('tab', { name: 'Xuất video' }).click();
  await expect(page.getByRole('heading', { name: 'Xuất video', exact: true })).toBeVisible();
  return { userId: p.userId, projectId: p.id, jobId: job.id };
}

const exportRows = (page: Page) => page.getByRole('row').filter({ hasText: 'Xuất lúc' });
const exportButton = (page: Page) => page.getByRole('button', { name: 'Xuất video', exact: true });

async function bytesOf(download: Download): Promise<Buffer> {
  return readFileSync(await download.path());
}
async function pick(page: Page, label: string, option: string) {
  await page.getByRole('combobox', { name: label }).click();
  await page.getByRole('option', { name: option }).click();
}
async function downloadSubtitle(page: Page): Promise<{ name: string; text: string }> {
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Tải phụ đề' }).click()]);
  return { name: download.suggestedFilename(), text: (await bytesOf(download)).toString('utf8') };
}

type Probe = { format: { duration: string }; streams: Array<{ codec_type: string; codec_name: string; width?: number; height?: number; nb_read_packets?: string }> };
function probe(buffer: Buffer, ext = 'mp4'): Probe {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'e2e-out-'));
  try {
    const file = path.join(dir, `v.${ext}`);
    writeFileSync(file, buffer);
    return JSON.parse(execFileSync(process.env.FFPROBE_PATH || 'ffprobe', ['-v', 'error', '-count_packets', '-show_format', '-show_streams', '-of', 'json', file], { encoding: 'utf8' })) as Probe;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('xuất video, tải thành phẩm và tệp phụ đề, hạn xóa hiện đúng, xóa bản xuất @mobile', async ({ page }) => {
  test.setTimeout(180_000);
  const source = makeVideoFile('xuat.mp4');
  const { projectId, jobId } = await openExport(page, source);
  await expect(page.getByTestId('video-estimate-size')).toContainText('~');
  await expect(page.getByText('Các con số là ước tính')).toBeVisible();
  await expect(page.getByText('Chưa có bản xuất nào')).toBeVisible();
  await expectNoHorizontalScroll(page);

  await exportButton(page).click();
  const row = exportRows(page);
  await expect(row).toHaveCount(1);
  // đang có bản xuất thì không tạo thêm được
  await expect(page.getByRole('status').filter({ hasText: 'đang có một bản xuất' })).toBeVisible();
  await expect(row.getByText('Hoàn tất')).toBeVisible({ timeout: 90_000 });
  await expect(row.getByText('100%')).toBeVisible();

  const [download] = await Promise.all([page.waitForEvent('download'), row.getByRole('link', { name: 'Tải video' }).click()]);
  expect(download.suggestedFilename()).toBe('xuat-phu-de.mp4');
  const out = probe(await bytesOf(download));
  const src = probe(source.buffer);
  const video = (p: Probe) => p.streams.find((s) => s.codec_type === 'video')!;
  expect(video(out)).toMatchObject({ codec_name: 'h264', width: 640, height: 360, nb_read_packets: video(src).nb_read_packets });
  expect(out.streams.find((s) => s.codec_type === 'audio')!.codec_name).toBe('aac');
  expect(Math.abs(Number(out.format.duration) - Number(src.format.duration))).toBeLessThanOrEqual(0.1);

  const srt = await downloadSubtitle(page);
  expect(srt.name).toBe('xuat.vi.srt');
  expect(srt.text).toContain('00:00:00,120 --> 00:00:01,180\nXin chào mọi người.');
  await pick(page, 'Định dạng', '.vtt');
  await pick(page, 'Nội dung', 'Song ngữ');
  const vtt = await downloadSubtitle(page);
  expect(vtt.name).toBe('xuat.en-vi.vtt');
  expect(vtt.text.startsWith('WEBVTT')).toBe(true);
  expect(vtt.text).toContain('Hello everyone.\nXin chào mọi người.');
  await pick(page, 'Định dạng', '.srt');
  await pick(page, 'Nội dung', 'Bản gốc');
  const original = await downloadSubtitle(page);
  expect(original.name).toBe('xuat.en.srt');
  expect(original.text).not.toContain('Xin chào');
  await page.getByRole('button', { name: 'Lưu thành kịch bản' }).click();
  await expect(page.getByText('Đã lưu phụ đề thành kịch bản của Project')).toBeVisible();

  // ngày xóa: thành phẩm 7 ngày sau khi tạo, video nguồn 48 giờ sau lần xuất
  const [saved] = await e2eQuery<{ days: number; hours: number }>(
    `select round(extract(epoch from (e.expires_at - e.finished_at)) / 86400) as days, round(extract(epoch from (j.source_expires_at - e.finished_at)) / 3600) as hours
     from video_exports e join video_jobs j on j.id = e.job_id where j.id = $1`,
    [jobId],
  );
  expect([Number(saved!.days), Number(saved!.hours)]).toEqual([7, 48]);
  await expectNoHorizontalScroll(page);

  // sửa phụ đề thì bản đã xuất được đánh dấu là cũ; xuất lại được mà không phải tải lên hay dịch lại
  await page.getByRole('tab', { name: /Phụ đề/ }).click();
  await page.getByRole('textbox', { name: 'Bản dịch đoạn 1', exact: true }).fill('Chào cả lớp.');
  await page.getByRole('tab', { name: 'Xuất video' }).click();
  await expect(exportRows(page).getByText('Phụ đề đã được sửa sau bản xuất này')).toBeVisible();

  await exportRows(page).getByRole('button', { name: /Xóa bản xuất/ }).click();
  const confirm = page.getByRole('alertdialog');
  await expect(confirm).toContainText('1 bản xuất, trả lại');
  await confirm.getByRole('button', { name: 'Xóa' }).click();
  await expect(page.getByText('Chưa có bản xuất nào')).toBeVisible();
  await page.getByRole('link', { name: 'Về Project' }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}\\?tab=video`));
});

test('video nguồn đã hết hạn: vẫn tải phụ đề, tải lại đúng video rồi xuất được', async ({ page }) => {
  test.setTimeout(180_000);
  const source = makeVideoFile('tai-lai.mp4');
  const { jobId } = await openExport(page, source);
  // như lượt dọn theo hạn: video nguồn và tệp dẫn xuất không còn
  await e2eQuery(`update users set video_used_bytes = 0 where id = (select owner_id from video_jobs where id = $1)`, [jobId]);
  await e2eQuery(`update video_jobs set source_state = 'deleted', source_key = null, audio_temp_key = null, source_expires_at = null where id = $1`, [jobId]);
  await page.reload();
  await page.getByRole('tab', { name: 'Xuất video' }).click();
  await expect(page.getByRole('heading', { name: 'Video nguồn đã bị xóa' })).toBeVisible();
  await expect(exportButton(page)).toBeDisabled();
  expect((await downloadSubtitle(page)).text).toContain('Xin chào mọi người.');

  const input = page.locator('input[type=file][aria-label="Chọn lại video gốc"]');
  await input.setInputFiles(makeVideoFile('khac.mp4', { seconds: 3 }));
  await expect(page.getByRole('alert').filter({ hasText: 'không phải video gốc' })).toBeVisible();
  await input.setInputFiles(source);
  await expect(exportButton(page)).toBeEnabled({ timeout: 60_000 });
  await expect(page.getByRole('heading', { name: 'Video nguồn đã bị xóa' })).toBeHidden();
  await exportButton(page).click();
  await expect(exportRows(page).getByText('Hoàn tất')).toBeVisible({ timeout: 90_000 });
  const usage = await e2eQuery<{ n: string }>('select count(*) as n from usage_records where video_job_id = $1 and ok', [jobId]);
  expect(Number(usage[0]!.n)).toBe(1);
});

test('Independent Test US3: video 5 phút xuất bằng kiểu mặc định giữ thời lượng, kích thước, số khung và tiếng', async ({ page }) => {
  test.setTimeout(420_000);
  const source = makeVideoFile('nam-phut.mp4', { seconds: 300, size: '1280x720', rate: 25 });
  await openExport(page, source);
  await exportButton(page).click();
  await expect(exportRows(page).getByText('Hoàn tất')).toBeVisible({ timeout: 300_000 });
  const [download] = await Promise.all([page.waitForEvent('download'), exportRows(page).getByRole('link', { name: 'Tải video' }).click()]);
  const out = probe(await bytesOf(download));
  const src = probe(source.buffer);
  const stream = (p: Probe, type: string) => p.streams.find((x) => x.codec_type === type)!;
  expect(stream(out, 'video')).toMatchObject({ codec_name: 'h264', width: 1280, height: 720, nb_read_packets: stream(src, 'video').nb_read_packets });
  expect(stream(out, 'audio')).toMatchObject({ codec_name: 'aac', nb_read_packets: stream(src, 'audio').nb_read_packets });
  expect(Math.abs(Number(out.format.duration) - Number(src.format.duration))).toBeLessThanOrEqual(0.1);
  for (const format of ['.srt', '.vtt']) {
    await pick(page, 'Định dạng', format);
    const file = await downloadSubtitle(page);
    expect(file.name).toBe(`nam-phut.vi${format}`);
    expect(file.text).toContain('Cảm ơn thầy.');
  }
});

test('US10: xuất riêng lớp phụ đề (.mp4 phông xanh và .mov trong suốt), đúng kích thước nguồn và chặn khi quá dài', async ({ browser, page }) => {
  test.setTimeout(180_000);
  const source = makeVideoFile('lop.mp4', { seconds: 6, size: '640x360', rate: 25 });
  const { jobId } = await openExport(page, source);
  const src = probe(source.buffer);
  const srcVideo = src.streams.find((s) => s.codec_type === 'video')!;

  await pick(page, 'Kiểu xuất', 'Xuất riêng lớp phụ đề');
  await expect(page.getByRole('combobox', { name: 'Nền và định dạng' })).toBeVisible();
  await expect(page.getByText('Chỉ xuất lớp phụ đề đúng kích thước và thời lượng nguồn')).toBeVisible();
  await expectNoHorizontalScroll(page);

  // 1) .mp4 phông xanh (#00FF00)
  await pick(page, 'Nền và định dạng', 'Phông xanh lá (#00FF00) · .mp4 (mọi phần mềm dựng phim)');
  await exportButton(page).click();
  const mp4Row = exportRows(page).filter({ hasText: 'Lớp phụ đề · .mp4' });
  await expect(mp4Row.getByText('Hoàn tất')).toBeVisible({ timeout: 90_000 });

  const [dlMp4] = await Promise.all([page.waitForEvent('download'), mp4Row.getByRole('link', { name: 'Tải video' }).click()]);
  expect(dlMp4.suggestedFilename()).toBe('lop-lop-phu-de.mp4');
  const outMp4 = probe(await bytesOf(dlMp4), 'mp4');
  expect(outMp4.streams.find((s) => s.codec_type === 'video')).toMatchObject({ codec_name: 'h264', width: srcVideo.width, height: srcVideo.height });
  expect(outMp4.streams.filter((s) => s.codec_type === 'audio')).toHaveLength(0);
  expect(Math.abs(Number(outMp4.format.duration) - Number(src.format.duration))).toBeLessThanOrEqual(0.1);

  // 2) .mov trong suốt (Premiere, DaVinci Resolve, After Effects)
  await pick(page, 'Nền và định dạng', 'Nền trong suốt · .mov (Premiere, DaVinci Resolve, After Effects)');
  await expect(page.getByText('Tệp .mov trong suốt rất lớn')).toBeVisible();
  await exportButton(page).click();
  await expect(exportRows(page)).toHaveCount(2);
  const movRow = exportRows(page).filter({ hasText: 'Lớp phụ đề · .mov' });
  await expect(movRow.getByText('Hoàn tất')).toBeVisible({ timeout: 90_000 });

  const [dlMov] = await Promise.all([page.waitForEvent('download'), movRow.getByRole('link', { name: 'Tải video' }).click()]);
  expect(dlMov.suggestedFilename()).toBe('lop-lop-phu-de.mov');
  const outMov = probe(await bytesOf(dlMov), 'mov');
  expect(outMov.streams.find((s) => s.codec_type === 'video')).toMatchObject({ codec_name: 'prores', width: srcVideo.width, height: srcVideo.height });
  expect(outMov.streams.filter((s) => s.codec_type === 'audio')).toHaveLength(0);
  expect(Math.abs(Number(outMov.format.duration) - Number(src.format.duration))).toBeLessThanOrEqual(0.1);

  // 3) Quá overlayMaxMinutesTransparent: .mov bị chặn kèm role="alert", .mp4 phông xanh vẫn bật
  const adminCtx = await browser.newContext({ locale: 'vi-VN' });
  const adminPage = await adminCtx.newPage();
  await adminSettings(adminPage, { overlayMaxMinutesTransparent: 1 });
  try {
    await e2eQuery(`update video_jobs set media = jsonb_set(media, '{durationMs}', '120000'::jsonb) where id = $1`, [jobId]);
    await page.reload();
    await page.getByRole('tab', { name: 'Xuất video' }).click();
    await pick(page, 'Kiểu xuất', 'Xuất riêng lớp phụ đề');
    await pick(page, 'Nền và định dạng', 'Nền trong suốt · .mov (Premiere, DaVinci Resolve, After Effects)');
    await expect(page.getByRole('alert').filter({ hasText: 'nền trong suốt' })).toBeVisible();
    await expect(exportButton(page)).toBeDisabled();
    await pick(page, 'Nền và định dạng', 'Phông xanh lá (#00FF00) · .mp4 (mọi phần mềm dựng phim)');
    await expect(exportButton(page)).toBeEnabled();
  } finally {
    await adminSettings(adminPage, { overlayMaxMinutesTransparent: 10 });
    await adminCtx.close();
  }
});
