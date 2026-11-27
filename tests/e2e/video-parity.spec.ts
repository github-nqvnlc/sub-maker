import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Page } from '@playwright/test';
import { startMockProvider, type MockProvider } from '../../mock-provider/server';
import { DEFAULT_VIDEO_STYLE, type VideoStyle } from '../../src/lib/video/style';
import { expect, test } from './fixtures';
import { hdr, jobRow, makeVideoFile, openVideoTab, startUpload, videoProject, waitVideoJob, type VideoFile } from './video-helpers';

/**
 * Spec 006, US4: SC-009 (tại 20 thời điểm, khung xem trước và video xuất ra cùng chữ, cùng cách xuống dòng, vị trí lệch ≤ 1% chiều
 * cao) trên video ngang và dọc; SC-007 (thay đổi hiện ≤ 0,2 giây); FR-030 (vùng an toàn chỉ có ở khung xem trước).
 */
let mock: MockProvider;
test.beforeAll(async () => {
  mock = await startMockProvider();
});
test.afterAll(async () => {
  await mock.close();
});

const FPS = 25;
const CELL = 4;

type Mask = { cells: Set<number>; box: { x0: number; y0: number; x1: number; y1: number } | null };

/** Mặt nạ "có chữ" quy về tọa độ của video: ô 4×4 điểm ảnh video. */
function maskOf(width: number, height: number, video: { width: number; height: number }, inked: (x: number, y: number) => boolean): Mask {
  const cells = new Set<number>();
  const sx = video.width / width;
  const sy = video.height / height;
  const columns = Math.ceil(video.width / CELL);
  let box: Mask['box'] = null;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!inked(x, y)) continue;
      const [vx, vy] = [(x + 0.5) * sx, (y + 0.5) * sy];
      cells.add(Math.floor(vy / CELL) * columns + Math.floor(vx / CELL));
      box = box ? { x0: Math.min(box.x0, vx), y0: Math.min(box.y0, vy), x1: Math.max(box.x1, vx), y1: Math.max(box.y1, vy) } : { x0: vx, y0: vy, x1: vx, y1: vy };
    }
  }
  return { cells, box };
}

function overlap(a: Mask, b: Mask): number {
  let both = 0;
  for (const c of a.cells) if (b.cells.has(c)) both++;
  const any = a.cells.size + b.cells.size - both;
  return any === 0 ? 1 : both / any;
}

/** Tua video xem trước tới một khung và đợi khung vẽ xong. */
async function seekPreview(page: Page, frame: number): Promise<void> {
  await page.getByTestId('video-preview-media').evaluate(
    async (el, seconds) => {
      const v = el as HTMLVideoElement;
      if (Math.abs(v.currentTime - seconds) > 0.0005) {
        await new Promise<void>((resolve) => {
          v.addEventListener('seeked', () => resolve(), { once: true });
          v.currentTime = seconds;
        });
      }
      for (let i = 0; i < 3; i++) await new Promise((r) => requestAnimationFrame(r));
    },
    frame / FPS + 0.001,
  );
}

async function previewMask(page: Page, video: { width: number; height: number }): Promise<Mask> {
  const shot = await page.getByTestId('video-preview-canvas').evaluate((el) => {
    const cv = el as HTMLCanvasElement;
    const d = cv.getContext('2d')!.getImageData(0, 0, cv.width, cv.height).data;
    let s = '';
    for (let i = 0; i < d.length; i += 0x8000) s += String.fromCharCode(...d.subarray(i, i + 0x8000));
    return { width: cv.width, height: cv.height, data: btoa(s) };
  });
  const data = Buffer.from(shot.data, 'base64');
  return maskOf(shot.width, shot.height, video, (x, y) => data[(y * shot.width + x) * 4 + 3]! >= 120);
}

async function videoMask(file: string, frame: number, size: { width: number; height: number }): Promise<Mask> {
  const { stdout } = await promisify(execFile)(
    process.env.FFMPEG_PATH || 'ffmpeg',
    ['-v', 'error', '-i', file, '-vf', `select=eq(n\\,${frame}),format=rgb24`, '-frames:v', '1', '-fps_mode', 'passthrough', '-f', 'rawvideo', 'pipe:1'],
    { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 },
  );
  // nền một màu: lấy màu ở góc làm mốc
  const at = (x: number, y: number) => (y * size.width + x) * 3;
  const bg = [stdout[at(2, 2)]!, stdout[at(2, 2) + 1]!, stdout[at(2, 2) + 2]!];
  return maskOf(size.width, size.height, size, (x, y) => {
    const o = at(x, y);
    return Math.abs(stdout[o]! - bg[0]!) + Math.abs(stdout[o + 1]! - bg[1]!) + Math.abs(stdout[o + 2]! - bg[2]!) >= 60;
  });
}

/** Thời gian (ms) từ thao tác của người dùng tới khi khung phụ đề đổi, đo trong trang. */
async function redrawDelay(page: Page, action: () => Promise<void>): Promise<number> {
  await page.getByTestId('video-preview-canvas').evaluate((el) => {
    const cv = el as HTMLCanvasElement;
    const hash = () => {
      const d = cv.getContext('2d')!.getImageData(0, 0, cv.width, cv.height).data;
      let h = 0;
      for (let i = 3; i < d.length; i += 28) h = (Math.imul(h, 31) + d[i]! + d[i - 3]!) | 0;
      return h;
    };
    const before = hash();
    (window as unknown as { __redraw: Promise<number> }).__redraw = new Promise((resolve) => {
      let started = 0;
      const mark = () => {
        started ||= performance.now();
      };
      for (const name of ['pointerdown', 'keydown']) window.addEventListener(name, mark, { capture: true, once: true });
      const tick = () => {
        if (started && hash() !== before) return resolve(performance.now() - started);
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  });
  await action();
  return page.evaluate(() => (window as unknown as { __redraw: Promise<number> }).__redraw);
}

async function openEditor(page: Page, projectId: string, source: VideoFile): Promise<string> {
  await openVideoTab(page, projectId);
  await startUpload(page, source);
  const job = await waitVideoJob(page, projectId, 'review_ready', 120_000);
  await jobRow(page, source.name).getByRole('link', { name: 'Mở' }).click();
  await expect(page.getByTestId('cue-row')).toHaveCount(3);
  await expect(page.getByTestId('video-preview-canvas')).toHaveAttribute('data-fonts', 'ready');
  return job.id;
}

/** Xuất bằng giao diện rồi tải thành phẩm của lượt xuất đó. */
async function exportVideo(page: Page, jobId: string, dir: string, name: string): Promise<string> {
  await page.getByRole('tab', { name: 'Xuất video' }).click();
  await page.getByRole('button', { name: 'Xuất video', exact: true }).click();
  const detail = async () => (await (await page.request.get(`/api/video/jobs/${jobId}`, { headers: hdr })).json()) as { exports: Array<{ id: string; status: string }> };
  await expect.poll(async () => (await detail()).exports[0]?.status, { timeout: 120_000, intervals: [500] }).toBe('completed');
  const file = path.join(dir, name);
  const res = await page.request.get(`/api/video/exports/${(await detail()).exports[0]!.id}/video`);
  expect(res.ok()).toBeTruthy();
  await writeFile(file, await res.body());
  return file;
}

async function compare(page: Page, file: string, size: { width: number; height: number }, frames: number[], name: string, notes: string[]): Promise<number> {
  let inked = 0;
  await page.getByRole('tab', { name: /^Phụ đề/ }).click();
  for (const frame of frames) {
    await seekPreview(page, frame);
    const preview = await previewMask(page, size);
    const video = await videoMask(file, frame, size);
    const where = `${name}, khung ${frame}`;
    expect(!!preview.box, `${where}: cùng có hoặc cùng không có chữ`).toBe(!!video.box);
    if (!preview.box || !video.box) continue;
    inked++;
    const tolerance = size.height * 0.01;
    for (const edge of ['x0', 'y0', 'x1', 'y1'] as const) expect(Math.abs(preview.box[edge] - video.box[edge]), `${where}: mép ${edge}`).toBeLessThanOrEqual(tolerance);
    // cùng chữ và cùng cách xuống dòng: vùng chữ trùng nhau
    const iou = overlap(preview, video);
    notes.push(`${where}: trùng ${(iou * 100).toFixed(1)}%`);
    expect(iou, `${where}: vùng chữ trùng nhau`).toBeGreaterThan(0.85);
  }
  return inked;
}

test('khung xem trước khớp video xuất ra tại 20 thời điểm, đổi kiểu hiện ngay @parity', async ({ page, browserName }) => {
  test.setTimeout(420_000);
  const p = await videoProject(page, mock);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'video-parity-'));
  const notes: string[] = [];
  try {
    // ---- video ngang 16:9, kiểu mặc định rồi bật hộp nền trên giao diện ----
    const wide = makeVideoFile('ngang.webm', { size: '640x360', color: '0x008000' });
    const wideJob = await openEditor(page, p.id, wide);
    await seekPreview(page, 15);

    await page.getByRole('textbox', { name: 'Bản dịch đoạn 1' }).click();
    await page.keyboard.press('End');
    const typing = await redrawDelay(page, () => page.keyboard.press('!'));
    expect(typing, 'sửa chữ hiện trên khung xem trước').toBeLessThanOrEqual(200);
    await expect(page.getByTestId('save-status')).toHaveText('Đã lưu');

    await page.getByRole('tab', { name: 'Kiểu chữ' }).click();
    await seekPreview(page, 15);
    const styling = await redrawDelay(page, () => page.getByRole('switch', { name: 'Hộp nền sau chữ' }).click());
    expect(styling, 'đổi kiểu hiện trên khung xem trước').toBeLessThanOrEqual(200);
    await expect(page.getByTestId('style-save-status')).toHaveText('Đã lưu');
    notes.push(`sửa chữ ${typing.toFixed(0)} ms, đổi kiểu ${styling.toFixed(0)} ms`);

    // khung ngang không có lựa chọn vùng an toàn
    await expect(page.getByRole('combobox', { name: 'Vùng bị che của mạng xã hội' })).toHaveCount(0);
    const wideFile = await exportVideo(page, wideJob, dir, 'ngang.mp4');
    const wideInked = await compare(page, wideFile, { width: 640, height: 360 }, [1, 6, 15, 26, 38, 50, 70, 88, 100, 130], '16:9', notes);

    // ---- video dọc 9:16, song ngữ, phông và vị trí khác, bật vùng an toàn ----
    const tall = makeVideoFile('doc.webm', { size: '360x640', color: '0x008000' });
    const tallJob = await openEditor(page, p.id, tall);
    const custom: VideoStyle = {
      ...DEFAULT_VIDEO_STYLE,
      display: 'bilingual',
      font: { family: 'montserrat', size: 64, weight: 800 },
      sourceLine: { size: 40, color: '#FFE08A', opacity: 90 },
      stroke: { enabled: false, color: '#000000', width: 4 },
      shadow: { enabled: true, color: '#000000', blur: 0, distance: 8, opacity: 100 },
      align: 'left',
      maxWidthPct: 70,
    };
    const put = await page.request.put(`/api/video/jobs/${tallJob}/style`, { data: custom, headers: hdr });
    expect(put.ok(), await put.text()).toBeTruthy();
    await page.reload();
    await expect(page.getByTestId('video-preview-canvas')).toHaveAttribute('data-fonts', 'ready');

    await expect(page.getByTestId('video-safe-zones')).toHaveCount(0);
    await page.getByRole('combobox', { name: 'Vùng bị che của mạng xã hội' }).click();
    await page.getByRole('option', { name: 'TikTok' }).click();
    await expect(page.getByTestId('video-safe-zones')).toBeVisible();
    // vị trí mặc định ở đáy lấn vùng chú thích
    await expect(page.getByTestId('safe-zone-warning')).toContainText('TikTok');

    const tallFile = await exportVideo(page, tallJob, dir, 'doc.mp4');
    // khung vùng an toàn đang bật ở xem trước nhưng không có trong video: mặt nạ vẫn khớp
    const tallInked = await compare(page, tallFile, { width: 360, height: 640 }, [8, 20, 28, 35, 48, 60, 80, 110, 120, 140], '9:16', notes);

    expect(wideInked + tallInked, 'đa số thời điểm có chữ').toBeGreaterThanOrEqual(14);
  } finally {
    await rm(dir, { recursive: true, force: true });
    console.log(`[video parity ${browserName}] ${notes.join('; ')}`);
  }
});
