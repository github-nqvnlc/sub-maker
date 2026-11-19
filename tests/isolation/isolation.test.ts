import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { stopBoss } from '@/worker/queues';
import { getDb } from '@/lib/db';
import { aiProviderConfigs } from '@/lib/db/schema';
import { startMockProvider, type MockProvider } from '../../mock-provider/server';
import { runGenerateVoice } from '@/worker/jobs/generate-voice';
import { FAST, newProject, putGlobalConfig, startJob, uploadScript, voiceOfJob } from '../integration/voice-helpers';
import {
  TestClient,
  clearRateLimits,
  createAdmin,
  createUser,
  resetDb,
  routeExists,
  type CallInit,
  type TestUser,
} from '../integration/helpers';

/**
 * Bộ kiểm thử CÔ LẬP DỮ LIỆU (Nguyên tắc I/V, SC-011).
 * Đọc contracts/openapi.yaml và kiểm tra MỌI thao tác đã được cài đặt:
 *   1) chưa đăng nhập        → 401
 *   2) User B với tài nguyên của User A → 404 (không phải 403 hay 200)
 *   3) User thường gọi /admin/* → 404
 * Mỗi story khi thêm route PHẢI thêm một ca vào CASES. Thao tác OpenAPI chưa cài là PENDING (không làm
 * test thất bại nếu còn PENDING — chế độ chặt luôn bật từ T157). Thao tác đã cài mà thiếu ca → test thất bại.
 */

type Ctx = { a: TestUser; b: TestUser; admin: TestUser };
type Case = {
  kind: 'self' | 'admin' | 'resource';
  /** Tạo tài nguyên thuộc User A, trả giá trị cho tham số đường dẫn. */
  setup?: (ctx: Ctx) => Promise<Record<string, string>>;
  init?: CallInit;
  /** Dựng init từ giá trị `setup` (ví dụ cần fileId trong body). */
  initFor?: (params: Record<string, string>) => CallInit;
  /** Phản hồi là luồng vô hạn (SSE): hủy ngay sau khi nhận header. */
  cancelBody?: boolean;
};

const ZERO_UUID = '00000000-0000-4000-8000-000000000000';

const textForm = (text: string) => {
  const f = new FormData();
  f.set('file', new File([text], 'k.txt', { type: 'text/plain' }));
  return f;
};
const makeProject = (u: TestUser) => newProject(u);
const makeFileIn = async (u: TestUser, projectId: string) => (await uploadScript(u, projectId, 'Một dòng đủ dài để đọc.')).id;
const makeFile = async (u: TestUser) => makeFileIn(u, await newProject(u));
const makeVoice = async (u: TestUser) => {
  const projectId = await newProject(u);
  const job = await startJob(u, projectId, await makeFileIn(u, projectId));
  await runGenerateVoice(job.id, FAST);
  return (await voiceOfJob(job.id))!.id;
};
const makeJob = async (u: TestUser) => {
  const projectId = await newProject(u);
  return (await startJob(u, projectId, await makeFileIn(u, projectId))).id;
};

// ----- Các ca kiểm thử theo từng story (mỗi story bổ sung vào đây) -----
const CASES: Record<string, Case> = {
  // US7
  'GET /me': { kind: 'self' },
  'PATCH /me': { kind: 'self', init: { json: { bio: 'x' } } },
  'GET /me/avatar': { kind: 'self' },
  'PUT /me/avatar': { kind: 'self', init: { form: new FormData() } },
  'DELETE /me/avatar': { kind: 'self' },
  'POST /me/password': { kind: 'self', init: { json: { currentPassword: 'x', newPassword: 'y' } } },
  'GET /admin/users': { kind: 'admin' },
  'PATCH /admin/users/{userId}': { kind: 'admin', init: { json: { canUseCustomAi: true } } },
  'DELETE /admin/users/{userId}': { kind: 'admin', init: {} },
  'POST /admin/users/{userId}/reset-password': { kind: 'admin', init: { json: { newPassword: 'Mat-Khau-Moi-8nP!zq' } } },
  // US9 — cấu hình AI (cấu hình riêng chỉ User trong danh sách; Admin quản lý cấu hình chung)
  'GET /providers': { kind: 'self' },
  'GET /me/ai-config': { kind: 'self' },
  'PUT /me/ai-config': { kind: 'self', init: { json: { type: 'fpt_marketplace', baseUrl: 'https://example.com/v1', apiKey: 'k' } } },
  'DELETE /me/ai-config/{type}': { kind: 'self' },
  'POST /me/ai-config/{type}/test': { kind: 'self' },
  'GET /admin/custom-ai-users': { kind: 'admin' },
  'POST /admin/custom-ai-users': { kind: 'admin', init: { json: { userId: ZERO_UUID } } },
  'DELETE /admin/custom-ai-users/{userId}': { kind: 'admin' },
  'GET /admin/ai-configs': { kind: 'admin' },
  'PUT /admin/ai-configs': { kind: 'admin', init: { json: { type: 'fpt_marketplace', baseUrl: 'https://example.com/v1', apiKey: 'k' } } },
  'DELETE /admin/ai-configs/{type}': { kind: 'admin' },
  'POST /admin/ai-configs/{type}/test': { kind: 'admin' },
  // US1 — Project, file, tiến trình, log, SSE (tài nguyên thuộc User A; User B phải nhận 404)
  'GET /projects': { kind: 'self' },
  'POST /projects': { kind: 'self', init: { json: { name: 'x', providerType: 'fpt_marketplace' } } },
  'GET /projects/{projectId}': { kind: 'resource', setup: async ({ a }) => ({ projectId: await makeProject(a) }) },
  'PATCH /projects/{projectId}': {
    kind: 'resource',
    setup: async ({ a }) => ({ projectId: await makeProject(a) }),
    init: { json: { description: 'Mô tả mới' } },
  },
  'GET /projects/{projectId}/files': { kind: 'resource', setup: async ({ a }) => ({ projectId: await makeProject(a) }) },
  'POST /projects/{projectId}/files': {
    kind: 'resource',
    setup: async ({ a }) => ({ projectId: await makeProject(a) }),
    init: { form: textForm('Nội dung thử.') },
  },
  'GET /files/{fileId}': { kind: 'resource', setup: async ({ a }) => ({ fileId: await makeFile(a) }) },
  'DELETE /files/{fileId}': { kind: 'resource', setup: async ({ a }) => ({ fileId: await makeFile(a) }) },
  'GET /files/{fileId}/raw': { kind: 'resource', setup: async ({ a }) => ({ fileId: await makeFile(a) }) },
  'GET /projects/{projectId}/jobs': { kind: 'resource', setup: async ({ a }) => ({ projectId: await makeProject(a) }) },
  'POST /projects/{projectId}/jobs': {
    kind: 'resource',
    setup: async ({ a }) => {
      const projectId = await makeProject(a);
      return { projectId, __fileId: await makeFileIn(a, projectId) };
    },
    initFor: (params) => ({ json: { fileId: params.__fileId } }),
  },
  'GET /jobs': { kind: 'self' },
  // US4/US5 — quản lý tiến trình, xóa
  'PATCH /jobs/{jobId}': { kind: 'resource', setup: async ({ a }) => ({ jobId: await makeJob(a) }), init: { json: { voice: 'thuminh' } } },
  'DELETE /jobs/{jobId}': { kind: 'resource', setup: async ({ a }) => ({ jobId: await makeJob(a) }) },
  'POST /jobs/{jobId}/stop': { kind: 'resource', setup: async ({ a }) => ({ jobId: await makeJob(a) }) },
  'POST /jobs/{jobId}/resume': { kind: 'resource', setup: async ({ a }) => ({ jobId: await makeJob(a) }) },
  'POST /jobs/{jobId}/rerun': { kind: 'resource', setup: async ({ a }) => ({ jobId: await makeJob(a) }), init: { json: {} } },
  'POST /jobs/bulk-delete': { kind: 'self', init: { json: { ids: ['00000000-0000-4000-8000-000000000000'] } } },
  'DELETE /projects/{projectId}': { kind: 'resource', setup: async ({ a }) => ({ projectId: await makeProject(a) }) },
  'POST /projects/bulk-delete': { kind: 'self', init: { json: { ids: ['00000000-0000-4000-8000-000000000000'] } } },
  // US3 — voice và audio (audio là dữ liệu nhạy cảm: User khác không được nghe/tải)
  'GET /voices/{voiceId}': { kind: 'resource', setup: async ({ a }) => ({ voiceId: await makeVoice(a) }) },
  'GET /voices/{voiceId}/audio': { kind: 'resource', setup: async ({ a }) => ({ voiceId: await makeVoice(a) }), cancelBody: true },
  'GET /jobs/{jobId}': { kind: 'resource', setup: async ({ a }) => ({ jobId: await makeJob(a) }) },
  'GET /jobs/{jobId}/logs': { kind: 'resource', setup: async ({ a }) => ({ jobId: await makeJob(a) }) },
  'GET /dashboard': { kind: 'self' },
  'GET /admin/stats': { kind: 'admin' },
  'GET /admin/settings': { kind: 'admin' },
  'PUT /admin/settings': { kind: 'admin', init: { json: { maxJobsPerUser: 2 } } },
  'GET /jobs/{jobId}/events': { kind: 'resource', setup: async ({ a }) => ({ jobId: await makeJob(a) }), cancelBody: true },
};

type Op = { key: string; method: string; template: string };

function loadOperations(): Op[] {
  const doc = parse(fs.readFileSync(path.resolve(process.cwd(), 'specs/001-voice-sub-projects/contracts/openapi.yaml'), 'utf8')) as {
    paths: Record<string, Record<string, unknown>>;
  };
  const ops: Op[] = [];
  for (const [template, item] of Object.entries(doc.paths)) {
    for (const method of ['get', 'put', 'post', 'patch', 'delete']) {
      if (item[method]) ops.push({ key: `${method.toUpperCase()} ${template}`, method: method.toUpperCase(), template });
    }
  }
  return ops;
}

const concrete = (template: string, params: Record<string, string> = {}) =>
  '/api' + template.replace(/\{(\w+)\}/g, (_m, name: string) => params[name] ?? ZERO_UUID);

const OPS = loadOperations();
let ctx: Ctx;
let mock: MockProvider;
const implemented: Op[] = [];
const pending: Op[] = [];

beforeAll(async () => {
  await resetDb();
  await clearRateLimits();
  mock = await startMockProvider();
  ctx = { a: await createUser({ name: 'Người A' }), b: await createUser({ name: 'Người B' }), admin: await createAdmin() };
  await getDb().delete(aiProviderConfigs);
  await putGlobalConfig(ctx.admin, mock, 'ok');
  for (const op of OPS) {
    (await routeExists(op.method, concrete(op.template)) ? implemented : pending).push(op);
  }
});
afterAll(async () => {
  await mock.close();
  await stopBoss();
});

describe('bao phủ', () => {
  it('mọi thao tác OpenAPI đã cài đặt đều có ca kiểm thử cô lập', () => {
    const missing = implemented.filter((op) => !CASES[op.key]).map((op) => op.key);
    expect(missing, `Thiếu ca cô lập cho: ${missing.join(', ')}`).toEqual([]);
  });

  it('không có ca thừa (ca cho thao tác không còn trong OpenAPI)', () => {
    const known = new Set(OPS.map((o) => o.key));
    const stale = Object.keys(CASES).filter((k) => !known.has(k));
    expect(stale).toEqual([]);
  });

  it('chế độ chặt: không còn thao tác PENDING', () => {
    expect(pending.map((p) => p.key)).toEqual([]);
  });

  it('báo cáo: số thao tác đã cài / còn PENDING', () => {
    console.log(`[isolation] đã cài ${implemented.length}/${OPS.length}, PENDING ${pending.length}`);
    expect(implemented.length + pending.length).toBe(OPS.length);
  });
});

describe('cô lập theo từng thao tác', () => {
  // Các ca được sinh lúc thu thập, dựa trên CASES (không phụ thuộc beforeAll)
  for (const [key, c] of Object.entries(CASES)) {
    const [method, template] = key.split(' ') as [string, string];

    describe(key, () => {
      it('chưa đăng nhập → 401', async (): Promise<void> => {
        const res = await new TestClient('anon').request(method, concrete(template), c.init);
        expect(res.status).toBe(401);
      });

      if (c.kind === 'admin') {
        it('User thường → 404 (không lộ chức năng quản trị)', async () => {
          const res = await ctx.b.client.request(method, concrete(template, { userId: ctx.a.id }), c.init);
          expect(res.status).toBe(404);
        });
      }

      if (c.kind === 'resource') {
        it('User B với tài nguyên của User A → 404', async () => {
          const params = await c.setup!(ctx);
          const res = await ctx.b.client.request(method, concrete(template, params), c.initFor ? c.initFor(params) : c.init);
          if (c.cancelBody) await res.body?.cancel().catch(() => undefined);
          expect(res.status, 'phải là 404, không phải 403 hay thành công').toBe(404);
        });

        it('chính User A truy cập được (ca kiểm thử hợp lệ, không phải 404)', async () => {
          const params = await c.setup!(ctx);
          const res = await ctx.a.client.request(method, concrete(template, params), c.initFor ? c.initFor(params) : c.init);
          if (c.cancelBody) await res.body?.cancel().catch(() => undefined);
          expect(res.status).not.toBe(404);
        });
      }
    });
  }
});
