import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startMockProvider, type MockProvider } from '../../mock-provider/server';
import { getDb } from '@/lib/db';
import { projects } from '@/lib/db/schema';
import { runGenerateVoice } from '@/worker/jobs/generate-voice';
import { stopBoss } from '@/worker/queues';
import { createAdmin, createUser, resetDb, type TestUser } from './helpers';
import { FAST, newProject, putGlobalConfig, startJob, uploadScript, voiceOfJob } from './voice-helpers';

/**
 * T159 — đo các tiêu chí hiệu năng của spec với nhà cung cấp GIẢ (đo phần xử lý của hệ thống, không đo độ trễ mạng thật):
 *  - SC-006: kịch bản ~5.000 ký tự → voice hoàn chỉnh ≤ 5 phút;
 *  - SC-007: 200 Project → tìm kiếm/lọc/sắp xếp < 1 giây;
 *  - SC-009: xóa 10 Project / 10 tiến trình cùng lúc < 5 giây.
 */
let mock: MockProvider;
let admin: TestUser;
let user: TestUser;

beforeAll(async () => {
  mock = await startMockProvider();
  await resetDb();
  admin = await createAdmin();
  await putGlobalConfig(admin, mock, 'ok');
  user = await createUser();
});
afterAll(async () => {
  await mock.close();
  await stopBoss();
});

const timed = async <T>(fn: () => Promise<T>): Promise<[T, number]> => {
  const t = performance.now();
  const r = await fn();
  return [r, performance.now() - t];
};

describe('hiệu năng (SC-006/007/009)', () => {
  it('SC-007: 200 Project — tìm kiếm, lọc, sắp xếp đều < 1 giây', async () => {
    await getDb()
      .insert(projects)
      .values(
        Array.from({ length: 200 }, (_, i) => ({
          ownerId: user.id,
          name: i % 7 === 0 ? `Lịch sử số ${i}` : `Dự án thử ${i}`,
          description: i % 5 === 0 ? 'Mô tả có từ khóa đặc biệt' : null,
          providerType: (['shopaikey_minimax', 'fpt_marketplace', 'shopaikey_openai'] as const)[i % 3]!,
        })),
      );
    const queries = ['q=lich+su', 'q=dac+biet', 'sort=name&order=asc', 'sort=voiceCount&order=desc', 'provider=fpt_marketplace', 'jobState=none&pageSize=100', 'q=du+an&sort=createdAt'];
    for (const qs of queries) {
      const [res, ms] = await timed(() => user.client.get(`/api/projects?${qs}`));
      expect(res.status).toBe(200);
      expect(ms, `/api/projects?${qs} mất ${Math.round(ms)} ms`).toBeLessThan(1000);
    }
  });

  it('SC-009: xóa 10 Project cùng lúc < 5 giây, không còn truy cập được', async () => {
    const ids = await Promise.all(Array.from({ length: 10 }, (_, i) => newProject(user, `Xóa hàng loạt ${i}`)));
    for (const id of ids.slice(0, 3)) await uploadScript(user, id, 'Một câu để có tệp.\nThêm một câu nữa.');
    const [res, ms] = await timed(() => user.client.post('/api/projects/bulk-delete', { json: { ids } }));
    expect(res.status).toBe(200);
    expect((await res.json()).deleted).toHaveLength(10);
    expect(ms, `xóa 10 Project mất ${Math.round(ms)} ms`).toBeLessThan(5000);
    for (const id of ids) expect((await user.client.get(`/api/projects/${id}`)).status).toBe(404);
  });

  it('SC-006 + SC-009: kịch bản ~5.000 ký tự tạo xong rất xa dưới 5 phút; xóa 10 tiến trình < 5 giây', async () => {
    const projectId = await newProject(user, 'Kịch bản dài');
    const sentence = 'Đây là một câu tiếng Việt có độ dài vừa phải để thử nghiệm quá trình tạo giọng nói.';
    const lines: string[] = [];
    let chars = 0;
    for (let i = 0; chars < 5000; i++) {
      const line = `${sentence} Câu số ${i + 1}.`;
      lines.push(line);
      chars += [...line].length;
    }
    const file = await uploadScript(user, projectId, lines.join('\n'));
    const job = await startJob(user, projectId, file.id);
    const [, ms] = await timed(() => runGenerateVoice(job.id, { ...FAST, segmentConcurrency: 3 }));
    const voice = await voiceOfJob(job.id);
    expect(voice, 'job không tạo được voice').not.toBeNull();
    console.log(`[perf] SC-006: ${chars} ký tự, ${file.segmentCount} đoạn → ${(ms / 1000).toFixed(1)} giây (nhà cung cấp giả)`);
    expect(ms).toBeLessThan(5 * 60_000);

    // 9 lần chạy lại nữa (đoạn lấy từ cache) rồi xóa cả 10 tiến trình
    const jobIds = [job.id];
    for (let i = 0; i < 9; i++) {
      const res = await user.client.post(`/api/jobs/${job.id}/rerun`, { json: {} });
      jobIds.push(((await res.json()) as { id: string }).id);
    }
    for (const id of jobIds.slice(1)) await runGenerateVoice(id, FAST);
    const [del, delMs] = await timed(() => user.client.post('/api/jobs/bulk-delete', { json: { ids: jobIds } }));
    expect(del.status).toBe(200);
    expect(((await del.json()) as { deleted: string[] }).deleted).toHaveLength(10);
    console.log(`[perf] SC-009: xóa 10 tiến trình (kèm voice) → ${Math.round(delMs)} ms`);
    expect(delMs).toBeLessThan(5000);
    for (const id of jobIds) expect((await user.client.get(`/api/jobs/${id}`)).status).toBe(404);
  });
});
