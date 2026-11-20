import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { E2E_ADMIN, ORIGIN, expect } from './fixtures';

const hdr = { Origin: ORIGIN };

/** Admin cấu hình AI chung trỏ tới nhà cung cấp giả với kịch bản cho trước, rồi đăng xuất. */
export async function setupProvider(page: Page, mockUrl: string, scenario = 'ok') {
  const signIn = await page.request.post('/api/auth/sign-in/email', { data: E2E_ADMIN, headers: hdr });
  expect(signIn.ok(), 'đăng nhập admin').toBeTruthy();
  const put = await page.request.put('/api/admin/ai-configs', {
    data: { type: 'fpt_marketplace', baseUrl: `${mockUrl}/s/${scenario}/v1`, apiKey: 'sk-e2e-helper-key-0003', defaultModel: 'FPT.AI-VITs', defaultVoice: 'banmai' },
    headers: hdr,
  });
  expect(put.ok(), `cấu hình AI chung: ${put.status()}`).toBeTruthy();
  await page.request.post('/api/auth/sign-out', { data: {}, headers: hdr });
}

/** Tạo Project qua API (page đã đăng nhập). */
export async function createProject(page: Page, name: string, description?: string): Promise<{ id: string; name: string }> {
  const res = await page.request.post('/api/projects', { data: { name, description, providerType: 'fpt_marketplace' }, headers: hdr });
  expect(res.status(), `tạo Project: ${await res.text()}`).toBe(201);
  return res.json();
}

export async function uploadScript(page: Page, projectId: string, lines: string[], name = 'kich-ban.txt'): Promise<{ id: string }> {
  const res = await page.request.post(`/api/projects/${projectId}/files`, {
    multipart: { file: { name, mimeType: 'text/plain', buffer: Buffer.from(lines.join('\n'), 'utf8') } },
    headers: hdr,
  });
  expect(res.status(), `tải kịch bản: ${await res.text()}`).toBe(201);
  return res.json();
}

/** Tải một tệp trong tests/fixtures (ví dụ sample-10s.srt) lên Project; trả về bản ghi tệp. */
export async function uploadSampleSrt(page: Page, projectId: string, fixtureName = 'sample-10s.srt'): Promise<{ id: string; hasTimecodes?: boolean; cueCount?: number }> {
  const buffer = fs.readFileSync(path.resolve(process.cwd(), 'tests/fixtures', fixtureName));
  const res = await page.request.post(`/api/projects/${projectId}/files`, {
    multipart: { file: { name: fixtureName, mimeType: 'application/x-subrip', buffer } },
    headers: hdr,
  });
  expect(res.status(), `tải phụ đề: ${await res.text()}`).toBe(201);
  return res.json();
}

/** Bắt đầu tiến trình ở chế độ khớp mốc thời gian (spec 003). */
export async function startTimedVoice(page: Page, projectId: string, fileId: string, opts: { mergeCues?: boolean } = {}): Promise<{ id: string }> {
  const res = await page.request.post(`/api/projects/${projectId}/jobs`, {
    data: { fileId, timing: { mode: 'timed', mergeCues: opts.mergeCues ?? true } },
    headers: hdr,
  });
  expect(res.status(), `bắt đầu voice khớp mốc: ${await res.text()}`).toBeLessThan(300);
  return res.json();
}

export async function startJob(page: Page, projectId: string, fileId: string): Promise<{ id: string }> {
  const res = await page.request.post(`/api/projects/${projectId}/jobs`, { data: { fileId }, headers: hdr });
  expect(res.status(), `bắt đầu tiến trình: ${await res.text()}`).toBeLessThan(300);
  return res.json();
}

export async function jobStatus(page: Page, jobId: string): Promise<string> {
  return (await (await page.request.get(`/api/jobs/${jobId}`)).json()).status;
}

export async function waitJob(page: Page, jobId: string, want: string | RegExp, timeout = 60_000) {
  await expect.poll(() => jobStatus(page, jobId), { timeout, intervals: [400] }).toMatch(typeof want === 'string' ? new RegExp(`^${want}$`) : want);
}
