import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { asc, eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { sttJobLogs, sttJobs, usageRecords } from '@/lib/db/schema';
import type { SttRunOptions } from '@/worker/jobs/transcribe-media';
import type { SonioxMock } from '../mocks/soniox-mock';
import type { TestUser } from './helpers';

/** Hàm dùng chung cho test STT (spec 004). */

export const SONIOX_KEY = 'sk-soniox-test-key-SECRET9876';

/** Chạy nhanh trong kiểm thử: thử lại ngắn, poll dày. */
export const FAST_STT: SttRunOptions = { retry: { maxAttempts: 4, baseMs: 5, maxMs: 20 }, pollMs: 5, maxPollMs: 10, heartbeatMs: 100 };

export async function putSonioxConfig(admin: TestUser, mock: SonioxMock, scenario = 'ok', over: Record<string, unknown> = {}) {
  const res = await admin.client.put('/api/admin/stt-config', { json: { baseUrl: mock.baseUrl(scenario), apiKey: SONIOX_KEY, ...over } });
  if (!res.ok) throw new Error(`putSonioxConfig: ${res.status} ${await res.text()}`);
  return res.json();
}

export const fixture = (name: string) => readFile(path.resolve(process.cwd(), 'tests/fixtures', name));

export async function postMedia(
  user: TestUser,
  projectId: string,
  file: { bytes: Uint8Array; name: string; type?: string },
  fields: Record<string, string> = {},
): Promise<Response> {
  const form = new FormData();
  form.set('file', new File([Buffer.from(file.bytes)], file.name, { type: file.type ?? 'application/octet-stream' }));
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return user.client.post(`/api/projects/${projectId}/stt`, { form });
}

export async function createSttJobApi(user: TestUser, projectId: string, fixtureName = 'sample-10s.mp3', fields: Record<string, string> = {}) {
  const res = await postMedia(user, projectId, { bytes: await fixture(fixtureName), name: fixtureName }, fields);
  if (res.status !== 201) throw new Error(`createSttJob: ${res.status} ${await res.text()}`);
  return (await res.json()) as { id: string; status: string; targetFileName: string };
}

export const sttJobRow = async (id: string) => (await getDb().select().from(sttJobs).where(eq(sttJobs.id, id)))[0];
export const sttLogKeys = async (id: string) =>
  (await getDb().select().from(sttJobLogs).where(eq(sttJobLogs.sttJobId, id)).orderBy(asc(sttJobLogs.id))).map((l) => l.messageKey);
export const sttUsageRows = (id: string) => getDb().select().from(usageRecords).where(eq(usageRecords.sttJobId, id)).orderBy(asc(usageRecords.id));
