import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { startMockProvider, type MockProvider } from '../../mock-provider/server';
import { DEFAULT_CONFIG, sizeOf, type OverlayConfig } from '../../src/lib/overlay/config';
import { frameTimeMs } from '../../src/lib/overlay/frames';
import { expect, test } from './fixtures';
import { hdr, openOverlay, overlayJobs, overlayProject, seek, waitOverlay } from './overlay-helpers';

/**
 * SC-005: tại 20 thời điểm, khung xem trước (trình duyệt) và khung trích từ video (tiến trình dựng hình) cùng chữ, cùng cách xuống dòng,
 * vị trí khối lệch ≤ 1% chiều cao; vùng bóng mờ rộng như nhau. Chromium là bắt buộc; Firefox/WebKit chạy thêm bằng E2E_BROWSERS.
 */
let mock: MockProvider;
test.beforeAll(async () => {
  mock = await startMockProvider();
});
test.afterAll(async () => {
  await mock.close();
});

type Mask = { width: number; height: number; /** 1 bit mỗi ô 4×4: có chữ hay không */ cells: Uint8Array; box: { x0: number; y0: number; x1: number; y1: number } | null };
const CELL = 4;

/** Mặt nạ "khác màu nền" từ điểm ảnh RGBA hoặc RGB. */
function maskOf(data: Uint8Array, width: number, height: number, stride: 3 | 4, bg: readonly number[]): Mask {
  const cw = Math.ceil(width / CELL);
  const ch = Math.ceil(height / CELL);
  const cells = new Uint8Array(cw * ch);
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * stride;
      const d = Math.abs(data[o]! - bg[0]!) + Math.abs(data[o + 1]! - bg[1]!) + Math.abs(data[o + 2]! - bg[2]!);
      if (d < 90) continue;
      cells[Math.floor(y / CELL) * cw + Math.floor(x / CELL)] = 1;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return { width, height, cells, box: x1 < 0 ? null : { x0, y0, x1, y1 } };
}
function overlap(a: Mask, b: Mask): number {
  let both = 0;
  let any = 0;
  for (let i = 0; i < a.cells.length; i++) {
    if (a.cells[i] && b.cells[i]) both++;
    if (a.cells[i] || b.cells[i]) any++;
  }
  return any === 0 ? 1 : both / any;
}

const config = (over: Partial<OverlayConfig>): OverlayConfig => ({ ...structuredClone(DEFAULT_CONFIG), ...over });
const CASES: Array<{ name: string; cfg: OverlayConfig; frames: number[] }> = [
  { name: '9:16 mặc định', cfg: config({}), frames: [15, 25, 40, 60, 80, 100, 120, 160, 185, 215, 240, 270] },
  {
    name: '16:9 bóng mờ, Montserrat rất đậm, canh trái',
    cfg: config({
      aspect: '16:9',
      font: { family: 'montserrat', size: 64, weight: 800 },
      stroke: { enabled: false, color: '#000000', width: 6 },
      shadow: { enabled: true, color: '#000000', blur: 24 },
      align: 'left',
      maxWidthPct: 60,
    }),
    frames: [30, 70, 110, 170, 230],
  },
  { name: '1:1 karaoke, Arimo', cfg: config({ aspect: '1:1', sync: 'karaoke', wordEffect: 'active', font: { family: 'arimo', size: 80, weight: 700 } }), frames: [45, 95, 200] },
];

test('khung xem trước khớp video xuất ra tại 20 thời điểm @parity', async ({ page, browserName }, info) => {
  test.setTimeout(240_000);
  const p = await overlayProject(page, mock, 'parity');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'overlay-parity-'));
  const notes: string[] = [];
  try {
    for (const [n, c] of CASES.entries()) {
      const { width, height } = sizeOf(c.cfg);
      const put = await page.request.put(`/api/projects/${p.id}/overlay`, { data: { config: { ...c.cfg, includeAudio: false }, source: {} }, headers: hdr });
      expect(put.ok(), await put.text()).toBeTruthy();
      await openOverlay(page, p.id);
      await page.getByRole('button', { name: 'Xuất Video Overlay' }).click();
      await expect.poll(async () => (await overlayJobs(page, p.id)).length).toBe(n + 1);
      await waitOverlay(page, p.id, 0, /^completed$/, 90_000);
      const file = path.join(dir, `v${n}.mp4`);
      await writeFile(file, await (await page.request.get(`/api/overlay/jobs/${(await overlayJobs(page, p.id))[0]!.id}/video`)).body());

      for (const f of c.frames) {
        await seek(page, frameTimeMs(f));
        const shot = await page.getByTestId('overlay-canvas').evaluate((el) => {
          const cv = el as HTMLCanvasElement;
          const d = cv.getContext('2d')!.getImageData(0, 0, cv.width, cv.height).data;
          let s = '';
          for (let i = 0; i < d.length; i += 0x8000) s += String.fromCharCode(...d.subarray(i, i + 0x8000));
          return btoa(s);
        });
        const preview = maskOf(Buffer.from(shot, 'base64'), width, height, 4, [0, 255, 0]);
        const { stdout } = await promisify(execFile)(
          'ffmpeg',
          ['-v', 'error', '-i', file, '-vf', `select=eq(n\\,${f}),scale=in_color_matrix=bt709:in_range=tv,format=rgb24`, '-frames:v', '1', '-fps_mode', 'passthrough', '-f', 'rawvideo', 'pipe:1'],
          { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 },
        );
        const video = maskOf(stdout, width, height, 3, [0, 255, 0]);
        const where = `${c.name}, khung ${f}`;
        expect(!!preview.box, `${where}: cùng có hoặc cùng không có chữ`).toBe(!!video.box);
        if (!preview.box || !video.box) continue;
        const tol = height * 0.01;
        for (const k of ['x0', 'y0', 'x1', 'y1'] as const) expect(Math.abs(preview.box[k] - video.box[k]), `${where}: mép ${k}`).toBeLessThanOrEqual(tol);
        // cùng chữ và cùng cách xuống dòng: vùng chữ trùng nhau gần như hoàn toàn
        const iou = overlap(preview, video);
        notes.push(`${where}: trùng ${(iou * 100).toFixed(1)}%`);
        expect(iou, `${where}: vùng chữ trùng nhau`).toBeGreaterThan(0.93);
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
    info.annotations.push({ type: browserName, description: notes.join('; ') });
    console.log(`[parity ${browserName}] ${notes.join('; ')}`);
  }
});
