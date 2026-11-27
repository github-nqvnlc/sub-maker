import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import pg from 'pg';
import type { MockProvider } from '../../mock-provider/server';
import { E2E_ADMIN, expect, ORIGIN, uniqueUser, type TestUser } from './fixtures';
import { createProject } from './helpers';

/** Hàm dùng chung cho E2E dịch video (spec 006). Soniox luôn là bản giả; video tạo bằng ffmpeg. */
export const hdr = { Origin: ORIGIN };
const MB = 1024 * 1024;

export type VideoFile = { name: string; mimeType: string; buffer: Buffer };

/**
 * Video thử ngắn. `padMb` nối một hộp `free` hợp lệ của MP4 vào cuối để tệp lớn hơn một phần tải (16 MB) mà vẫn đọc được.
 */
export function makeVideoFile(name: string, opts: { seconds?: number; padMb?: number; size?: string; rate?: number; color?: string } = {}): VideoFile {
  const { seconds = 6, padMb = 0, size = '640x360', rate = 25, color } = opts;
  // `color`: nền một màu để tách vùng chữ khi so khung
  const picture = color ? `color=c=${color}:s=${size}:r=${rate}:d=${seconds}` : `testsrc2=s=${size}:r=${rate}:d=${seconds}`;
  // đuôi quyết định định dạng: .webm phát được ở mọi trình duyệt, .avi (MPEG-4) thì không
  const ext = name.endsWith('.webm') ? 'webm' : name.endsWith('.avi') ? 'avi' : 'mp4';
  const codecs = {
    webm: ['-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-pix_fmt', 'yuv420p', '-c:a', 'libopus'],
    avi: ['-c:v', 'mpeg4', '-q:v', '5', '-c:a', 'libmp3lame'],
    mp4: ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart'],
  }[ext];
  const dir = mkdtempSync(path.join(os.tmpdir(), 'e2e-video-'));
  try {
    const file = path.join(dir, `v.${ext}`);
    const r = spawnSync(
      process.env.FFMPEG_PATH || 'ffmpeg',
      ['-v', 'error', '-f', 'lavfi', '-i', picture, '-f', 'lavfi', '-i', `sine=frequency=600:duration=${seconds}`, ...codecs, '-y', file],
      { stdio: 'inherit' },
    );
    if (r.status !== 0) throw new Error('Không tạo được video thử');
    let buffer = readFileSync(file);
    if (padMb > 0) {
      const pad = Buffer.alloc(padMb * MB);
      pad.writeUInt32BE(pad.length, 0);
      pad.write('free', 4, 'latin1');
      buffer = Buffer.concat([buffer, pad]);
    }
    return { name, mimeType: ext === 'webm' ? 'video/webm' : ext === 'avi' ? 'video/x-msvideo' : 'video/mp4', buffer };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function asAdmin<T>(page: Page, run: () => Promise<T>): Promise<T> {
  const signIn = await page.request.post('/api/auth/sign-in/email', { data: E2E_ADMIN, headers: hdr });
  expect(signIn.ok(), 'đăng nhập admin').toBeTruthy();
  try {
    return await run();
  } finally {
    await page.request.post('/api/auth/sign-out', { data: {}, headers: hdr });
  }
}

export async function adminSettings(page: Page, patch: Record<string, number>): Promise<void> {
  await asAdmin(page, async () => {
    const res = await page.request.put('/api/admin/settings', { data: patch, headers: hdr });
    expect(res.ok(), `cài đặt: ${await res.text()}`).toBeTruthy();
  });
}

/**
 * User mới + Project, Soniox trỏ tới máy chủ giả; `allowed` quyết định User có quyền Dịch Video. Trang kết thúc ở trạng thái đã
 * đăng nhập bằng User đó.
 */
export async function videoProject(page: Page, mock: MockProvider, opts: { allowed?: boolean; scenario?: string } = {}): Promise<{ user: TestUser; userId: string; id: string }> {
  const user = uniqueUser('video');
  const signUp = await page.request.post('/api/auth/sign-up/email', { data: { email: user.email, password: user.password, name: user.displayName }, headers: hdr });
  expect(signUp.ok(), `đăng ký: ${await signUp.text()}`).toBeTruthy();
  const userId = ((await signUp.json()) as { user: { id: string } }).user.id;
  await page.request.post('/api/auth/sign-out', { data: {}, headers: hdr });
  await asAdmin(page, async () => {
    const stt = await page.request.put('/api/admin/stt-config', {
      data: { baseUrl: `${mock.url}/soniox/s/${opts.scenario ?? 'ok'}`, apiKey: 'sk-e2e-soniox-key-0004', enabled: true },
      headers: hdr,
    });
    expect(stt.ok(), `cấu hình Soniox: ${await stt.text()}`).toBeTruthy();
    if (opts.allowed ?? true) {
      const grant = await page.request.patch(`/api/admin/users/${userId}`, { data: { canTranslateVideo: true }, headers: hdr });
      expect(grant.ok(), `cấp quyền: ${await grant.text()}`).toBeTruthy();
    }
  });
  const signIn = await page.request.post('/api/auth/sign-in/email', { data: { email: user.email, password: user.password }, headers: hdr });
  expect(signIn.ok()).toBeTruthy();
  const project = await createProject(page, 'Dịch video');
  return { user, userId, id: project.id };
}

export async function openVideoTab(page: Page, projectId: string): Promise<void> {
  await page.goto(`/projects/${projectId}`);
  await page.getByRole('tab', { name: /Dịch Video/ }).click();
  await expect(page.getByRole('heading', { name: 'Dịch video và gắn phụ đề' })).toBeVisible();
}

export const PICK_LABEL = 'Kéo thả video vào đây hoặc bấm để chọn';

export async function chooseVideo(page: Page, file: VideoFile, label: string = PICK_LABEL): Promise<void> {
  const input = page.locator(`input[type=file][aria-label="${label}"]`);
  if (file.buffer.length < 45 * MB) return input.setInputFiles(file);
  // Playwright chỉ nhận bộ đệm dưới 50 MB: ghi ra đĩa (trình duyệt đọc dần trong lúc tải nên giữ tệp lại)
  const onDisk = path.join(mkdtempSync(path.join(os.tmpdir(), 'e2e-big-')), file.name);
  writeFileSync(onDisk, file.buffer);
  await input.setInputFiles(onDisk);
}

export async function startUpload(page: Page, file: VideoFile): Promise<void> {
  await chooseVideo(page, file);
  await page.getByRole('button', { name: 'Tải lên và dịch' }).click();
}

export const jobRow = (page: Page, name: string) => page.getByRole('row').filter({ hasText: name });

export type VideoJobApi = { id: string; displayStatus: string; cueCount: number; progressPercent: number; fileName: string };
export async function videoJobs(page: Page, projectId: string): Promise<VideoJobApi[]> {
  const res = await page.request.get(`/api/projects/${projectId}/video/jobs`);
  expect(res.ok()).toBeTruthy();
  return res.json();
}

export async function waitVideoJob(page: Page, projectId: string, status: string, timeout = 60_000): Promise<VideoJobApi> {
  await expect.poll(async () => (await videoJobs(page, projectId))[0]?.displayStatus, { timeout, intervals: [500] }).toBe(status);
  return (await videoJobs(page, projectId))[0]!;
}

/** Truy vấn thẳng CSDL E2E (kiểm kịch bản đã lưu). */
export async function e2eQuery<T extends pg.QueryResultRow>(sql: string, values: unknown[] = []): Promise<T[]> {
  if (!process.env.DATABASE_URL) process.loadEnvFile(path.resolve(process.cwd(), '.env'));
  const url = new URL(process.env.DATABASE_URL!);
  url.pathname = '/submaker_e2e';
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  try {
    return (await client.query<T>(sql, values)).rows;
  } finally {
    await client.end();
  }
}
