import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import type { MockProvider } from '../../mock-provider/server';
import { expect, ORIGIN, registerViaApi, uniqueUser, type TestUser } from './fixtures';
import { createProject, setupProvider, startTimedVoice, uploadSampleSrt, waitJob } from './helpers';

/** Hàm dùng chung cho E2E video overlay (spec 005). Dữ liệu ≤ 10 giây. */

export const fixture = (name: string): Buffer => fs.readFileSync(path.resolve(process.cwd(), 'tests/fixtures', name));
export const hdr = { Origin: ORIGIN };

/** User mới + Project có tệp mẫu (3 cue) và voice khớp mốc từ chính tệp đó. */
export async function overlayProject(page: Page, mock: MockProvider, prefix = 'overlay'): Promise<{ user: TestUser; id: string; fileId: string }> {
  await setupProvider(page, mock.url, 'ms-60');
  const user = uniqueUser(prefix);
  await registerViaApi(page.request, user);
  const project = await createProject(page, 'Video overlay');
  const file = await uploadSampleSrt(page, project.id);
  const job = await startTimedVoice(page, project.id, file.id);
  await waitJob(page, job.id, 'completed');
  return { user, id: project.id, fileId: file.id };
}

/** Mở tab Video Overlay và chờ khung xem trước sẵn sàng (nếu có nguồn). */
export async function openOverlay(page: Page, projectId: string, opts: { preview?: boolean } = {}) {
  await page.goto(`/projects/${projectId}`);
  await page.getByRole('tab', { name: /Video Overlay/ }).click();
  if (opts.preview ?? true) await expect(page.getByTestId('overlay-canvas')).toHaveAttribute('data-fonts', 'ready');
}

/** Không cuộn ngang toàn trang. */
export async function expectNoHorizontalScroll(page: Page) {
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(over, 'trang không được cuộn ngang').toBeLessThanOrEqual(0);
}

/** Tua khung xem trước tới mốc (ms) và chờ vẽ xong. */
export async function seek(page: Page, ms: number) {
  await page.getByTestId('overlay-audio').evaluate(async (el, sec) => {
    const a = el as HTMLAudioElement;
    if (Math.abs(a.currentTime - sec) > 0.0005) {
      await new Promise<void>((resolve) => {
        a.addEventListener('seeked', () => resolve(), { once: true });
        a.currentTime = sec;
      });
    }
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  }, ms / 1000);
}

export type Box = { x: number; y: number; w: number; h: number; pixels: number };

/** Vùng chữ trên khung xem trước: hộp bao của các điểm ảnh khác màu nền (theo kích thước xuất). */
export async function previewBox(page: Page, background: [number, number, number] = [0, 255, 0]): Promise<Box | null> {
  return page.getByTestId('overlay-canvas').evaluate((el, bg) => {
    const c = el as HTMLCanvasElement;
    const { data } = c.getContext('2d')!.getImageData(0, 0, c.width, c.height);
    let x0 = c.width;
    let y0 = c.height;
    let x1 = -1;
    let y1 = -1;
    let pixels = 0;
    for (let y = 0; y < c.height; y++) {
      for (let x = 0; x < c.width; x++) {
        const o = (y * c.width + x) * 4;
        if (data[o + 3]! < 8) continue;
        if (Math.abs(data[o]! - bg[0]!) + Math.abs(data[o + 1]! - bg[1]!) + Math.abs(data[o + 2]! - bg[2]!) < 60 && data[o + 3]! > 200) continue;
        pixels++;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
    return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1, pixels };
  }, background);
}

/** Mã băm nội dung khung xem trước (so hai thời điểm). */
export async function previewHash(page: Page): Promise<number> {
  return page.getByTestId('overlay-canvas').evaluate((el) => {
    const c = el as HTMLCanvasElement;
    const d = new Uint32Array(c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data.buffer);
    let h = 2166136261;
    for (let i = 0; i < d.length; i++) h = Math.imul(h ^ d[i]!, 16777619);
    return h >>> 0;
  });
}

export type ListedJob = { id: string; status: string; sizeBytes: number | null };

export async function overlayJobs(page: Page, projectId: string): Promise<ListedJob[]> {
  return (await (await page.request.get(`/api/projects/${projectId}/overlay/jobs`)).json()) as ListedJob[];
}

export async function waitOverlay(page: Page, projectId: string, index: number, want: RegExp, timeout = 60_000) {
  await expect.poll(async () => (await overlayJobs(page, projectId))[index]?.status ?? '', { timeout, intervals: [400] }).toMatch(want);
}

export async function usedBytes(page: Page, projectId: string): Promise<number> {
  return ((await (await page.request.get(`/api/projects/${projectId}/overlay`)).json()) as { limits: { usedBytes: number } }).limits.usedBytes;
}
