import { asc, eq } from 'drizzle-orm';
import type { MockProvider } from '../../mock-provider/server';
import { getDb } from '@/lib/db';
import { jobLogs, jobSegments, usageRecords, voiceJobs, voices } from '@/lib/db/schema';
import type { RunOptions } from '@/worker/jobs/generate-voice';
import type { TestUser } from './helpers';

/** Hàm dùng chung cho các test tạo voice: cấu hình AI, Project, upload, tạo job, đọc trạng thái. */

export const GLOBAL_KEY = 'sk-global-shared-key-ZZZZ9999';

/** Tùy chọn chạy nhanh cho kiểm thử (thử lại ngắn, heartbeat dày, polling nhanh). */
export const FAST: RunOptions = {
  retry: { maxAttempts: 3, baseMs: 5, maxMs: 20 },
  heartbeatMs: 100,
  polling: { initialMs: 10, maxMs: 20, timeoutMs: 3000 },
  segmentConcurrency: 2,
};

export const SCRIPT_4 = ['Xin chào các bạn.', 'Hôm nay chúng ta học bài mới.', 'Đây là đoạn thứ ba.', 'Cảm ơn đã theo dõi.'].join('\n');

export async function putGlobalConfig(admin: TestUser, mock: MockProvider, scenario = 'ok', over: Record<string, unknown> = {}) {
  const res = await admin.client.put('/api/admin/ai-configs', {
    json: {
      type: 'fpt_marketplace',
      baseUrl: `${mock.url}/s/${scenario}/v1`,
      apiKey: GLOBAL_KEY,
      defaultModel: 'FPT.AI-VITs',
      defaultVoice: 'banmai',
      ...over,
    },
  });
  if (!res.ok) throw new Error(`putGlobalConfig: ${res.status} ${await res.text()}`);
}

/** Đổi kịch bản của cấu hình chung (giữ khóa cũ). */
export async function setScenario(admin: TestUser, mock: MockProvider, scenario: string) {
  await putGlobalConfig(admin, mock, scenario, { apiKey: undefined });
}

export async function newProject(user: TestUser, name = 'Dự án thử', providerType = 'fpt_marketplace'): Promise<string> {
  const res = await user.client.post('/api/projects', { json: { name, providerType } });
  if (res.status !== 201) throw new Error(`newProject: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { id: string }).id;
}

export type UploadedFile = { id: string; segmentCount: number; segments: Array<{ idx: number; text: string }> };

export async function uploadScript(user: TestUser, projectId: string, text: string, name = 'kich-ban.txt'): Promise<UploadedFile> {
  const form = new FormData();
  form.set('file', new File([text], name, { type: 'text/plain' }));
  const res = await user.client.post(`/api/projects/${projectId}/files`, { form });
  if (res.status !== 201) throw new Error(`uploadScript: ${res.status} ${await res.text()}`);
  return (await res.json()) as UploadedFile;
}

export type JobDto = { id: string; status: string; progressDone: number; progressTotal: number; errorCode: string | null; configScope: string };

export async function startJob(user: TestUser, projectId: string, fileId: string, over: Record<string, unknown> = {}): Promise<JobDto> {
  const res = await user.client.post(`/api/projects/${projectId}/jobs`, { json: { fileId, ...over } });
  if (res.status !== 202) throw new Error(`startJob: ${res.status} ${await res.text()}`);
  return (await res.json()) as JobDto;
}

export const jobRow = async (id: string) => (await getDb().select().from(voiceJobs).where(eq(voiceJobs.id, id)))[0]!;
export const segmentRows = (jobId: string) => getDb().select().from(jobSegments).where(eq(jobSegments.jobId, jobId)).orderBy(asc(jobSegments.idx));
export const logRows = (jobId: string) => getDb().select().from(jobLogs).where(eq(jobLogs.jobId, jobId)).orderBy(asc(jobLogs.id));
export const logCodes = async (jobId: string) => (await logRows(jobId)).map((l) => l.code);
export const usageRows = (jobId: string) => getDb().select().from(usageRecords).where(eq(usageRecords.jobId, jobId)).orderBy(asc(usageRecords.id));
export const voiceOfJob = async (jobId: string) => (await getDb().select().from(voices).where(eq(voices.jobId, jobId)))[0] ?? null;
export const postCount = (mock: MockProvider) => mock.requests.filter((r) => r.method === 'POST').length;
