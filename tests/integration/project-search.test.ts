import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '@/lib/db';
import { projects, subtitleFiles, voiceJobs } from '@/lib/db/schema';
import { stopBoss } from '@/worker/queues';
import { TestClient, clearRateLimits, createUser, resetDb, type TestUser } from './helpers';

let a: TestUser;

type Item = { id: string; name: string; description: string | null; providerType: string; voiceCount: number; runningJobs: number; failedJobs: number };
type Page = { items: Item[]; total: number; page: number; pageSize: number };

const list = async (c: TestClient, qs = ''): Promise<Page> => {
  const res = await c.get(`/api/projects${qs ? `?${qs}` : ''}`);
  if (!res.ok) throw new Error(`list ${qs}: ${res.status} ${await res.text()}`);
  return (await res.json()) as Page;
};
const names = (p: Page) => p.items.map((i) => i.name);

async function create(u: TestUser, name: string, over: Record<string, unknown> = {}) {
  const res = await u.client.post('/api/projects', { json: { name, providerType: 'fpt_marketplace', ...over } });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string };
}

/** Thêm một job thẳng vào DB để có trạng thái cần lọc (không cần chạy worker). */
async function addJob(u: TestUser, projectId: string, status: 'queued' | 'running' | 'failed' | 'completed') {
  const db = getDb();
  const [file] = await db
    .insert(subtitleFiles)
    .values({ projectId, ownerId: u.id, originalName: 'k.txt', ext: 'txt', sizeBytes: 1, storageKey: `x/${Math.random()}`, contentHash: 'h', charCount: 1, segmentCount: 1 })
    .returning();
  await db.insert(voiceJobs).values({ projectId, ownerId: u.id, subtitleFileId: file!.id, status, providerType: 'fpt_marketplace', configScope: 'global', settings: { voice: 'banmai' } });
}

beforeAll(async () => {
  await resetDb();
});
afterAll(async () => {
  await stopBoss();
});
beforeEach(async () => {
  await clearRateLimits();
  await getDb().delete(projects);
  a = await createUser({ name: 'Người tìm kiếm' });
});

describe('tìm kiếm không dấu (FR-006)', () => {
  beforeEach(async () => {
    await create(a, 'Kịch bản lịch sử Việt Nam', { description: 'Các video về thời Trần' });
    await create(a, 'Đường đến thành công');
    await create(a, 'Du lịch Đà Nẵng', { description: 'Vlog biển Mỹ Khê' });
    await create(a, 'Hướng dẫn nấu ăn');
    await create(a, 'Học tiếng Anh', { providerType: 'shopaikey_openai' });
  });

  it('gõ không dấu khớp tên có dấu, không phân biệt hoa/thường', async () => {
    expect(names(await list(a.client, 'q=kich+ban'))).toEqual(['Kịch bản lịch sử Việt Nam']);
    expect(names(await list(a.client, 'q=KICH+BAN'))).toEqual(['Kịch bản lịch sử Việt Nam']);
    expect(names(await list(a.client, 'q=huong+dan+nau'))).toEqual(['Hướng dẫn nấu ăn']);
    expect(names(await list(a.client, 'q=hoc+tieng'))).toEqual(['Học tiếng Anh']);
  });

  it('chữ đ/Đ được xử lý đúng ("duong" khớp "Đường", "da nang" khớp "Đà Nẵng")', async () => {
    expect(names(await list(a.client, 'q=duong'))).toEqual(['Đường đến thành công']);
    expect(names(await list(a.client, 'q=DA+NANG'))).toEqual(['Du lịch Đà Nẵng']);
    expect(names(await list(a.client, 'q=%C4%90%C3%A0+N%E1%BA%B5ng'))).toEqual(['Du lịch Đà Nẵng']); // gõ có dấu "Đà Nẵng"
  });

  it('khớp cả mô tả', async () => {
    expect(names(await list(a.client, 'q=tran'))).toEqual(['Kịch bản lịch sử Việt Nam']);
    expect(names(await list(a.client, 'q=my+khe'))).toEqual(['Du lịch Đà Nẵng']);
  });

  it('khớp một phần từ (chuỗi con) và nhiều từ liền nhau', async () => {
    expect(names(await list(a.client, 'q=lich'))).toEqual(expect.arrayContaining(['Kịch bản lịch sử Việt Nam', 'Du lịch Đà Nẵng']));
    expect(names(await list(a.client, 'q=viet+nam'))).toEqual(['Kịch bản lịch sử Việt Nam']);
  });

  it('không có kết quả → danh sách rỗng, total 0', async () => {
    const p = await list(a.client, 'q=khong-co-gi-ca');
    expect(p).toMatchObject({ items: [], total: 0 });
  });

  it('ký tự đặc biệt của LIKE (%, _, \\) được coi là chữ thường, không phải ký tự đại diện', async () => {
    await create(a, '100% hoàn thành');
    await create(a, 'file_name_test');
    expect(names(await list(a.client, 'q=%25'))).toEqual(['100% hoàn thành']); // chỉ tên chứa dấu %
    expect(names(await list(a.client, 'q=_'))).toEqual(['file_name_test']);
    expect(names(await list(a.client, 'q=%5C'))).toEqual([]); // dấu \ không có trong tên nào
  });

  it('từ khóa rỗng hoặc chỉ khoảng trắng → trả toàn bộ', async () => {
    expect((await list(a.client, 'q=')).total).toBe(5);
    expect((await list(a.client, 'q=+++')).total).toBe(5);
  });
});

describe('sắp xếp (FR-007)', () => {
  beforeEach(async () => {
    for (const n of ['Charlie', 'alpha', 'Bravo']) {
      await create(a, n);
      await new Promise((r) => setTimeout(r, 15)); // createdAt khác nhau
    }
  });

  it('theo tên (không phân biệt hoa/thường) tăng/giảm', async () => {
    expect(names(await list(a.client, 'sort=name&order=asc'))).toEqual(['alpha', 'Bravo', 'Charlie']);
    expect(names(await list(a.client, 'sort=name&order=desc'))).toEqual(['Charlie', 'Bravo', 'alpha']);
  });

  it('theo ngày tạo tăng/giảm', async () => {
    expect(names(await list(a.client, 'sort=createdAt&order=asc'))).toEqual(['Charlie', 'alpha', 'Bravo']);
    expect(names(await list(a.client, 'sort=createdAt&order=desc'))).toEqual(['Bravo', 'alpha', 'Charlie']);
  });

  it('theo ngày cập nhật: mặc định mới nhất trước; sửa Project thì lên đầu', async () => {
    expect(names(await list(a.client))).toEqual(['Bravo', 'alpha', 'Charlie']);
    const charlie = (await list(a.client)).items.find((i) => i.name === 'Charlie')!;
    await a.client.patch(`/api/projects/${charlie.id}`, { json: { description: 'vừa sửa' } });
    expect(names(await list(a.client, 'sort=updatedAt&order=desc'))[0]).toBe('Charlie');
    expect(names(await list(a.client, 'sort=updatedAt&order=asc'))[2]).toBe('Charlie');
  });

  it('theo số voice tăng/giảm', async () => {
    const items = (await list(a.client)).items;
    const counts: Record<string, number> = { alpha: 5, Bravo: 0, Charlie: 2 };
    for (const i of items) await getDb().update(projects).set({ voiceCount: counts[i.name]! }).where(eq(projects.id, i.id));
    expect(names(await list(a.client, 'sort=voiceCount&order=desc'))).toEqual(['alpha', 'Charlie', 'Bravo']);
    expect(names(await list(a.client, 'sort=voiceCount&order=asc'))).toEqual(['Bravo', 'Charlie', 'alpha']);
    expect((await list(a.client, 'sort=voiceCount&order=desc')).items.map((i) => i.voiceCount)).toEqual([5, 2, 0]);
  });

  it('khi trùng giá trị sắp xếp, thứ tự vẫn ổn định giữa các lần gọi và các trang', async () => {
    for (let i = 0; i < 6; i++) await create(a, 'Trùng tên');
    const full = (await list(a.client, 'sort=name&order=asc&pageSize=100')).items.map((i) => i.id);
    const p1 = (await list(a.client, 'sort=name&order=asc&pageSize=3&page=1')).items.map((i) => i.id);
    const p2 = (await list(a.client, 'sort=name&order=asc&pageSize=3&page=2')).items.map((i) => i.id);
    expect([...p1, ...p2]).toEqual(full.slice(0, 6));
    expect(new Set([...p1, ...p2]).size).toBe(6); // không trùng giữa các trang
  });

  it('tham số sắp xếp không hợp lệ → 422', async () => {
    expect((await a.client.get('/api/projects?sort=owner')).status).toBe(422);
    expect((await a.client.get('/api/projects?order=up')).status).toBe(422);
  });
});

describe('lọc (FR-008)', () => {
  let p: Record<string, string>;

  beforeEach(async () => {
    p = {};
    p.speech = (await create(a, 'Dùng ShopAIKey', { providerType: 'shopaikey_openai' })).id;
    p.running = (await create(a, 'Đang chạy')).id;
    p.queued = (await create(a, 'Đang chờ')).id;
    p.failed = (await create(a, 'Bị lỗi')).id;
    p.done = (await create(a, 'Đã xong')).id;
    p.empty = (await create(a, 'Chưa có tiến trình')).id;
    await addJob(a, p.running!, 'running');
    await addJob(a, p.queued!, 'queued');
    await addJob(a, p.failed!, 'failed');
    await addJob(a, p.done!, 'completed');
  });

  it('theo nhà cung cấp', async () => {
    expect(names(await list(a.client, 'provider=shopaikey_openai'))).toEqual(['Dùng ShopAIKey']);
    expect((await list(a.client, 'provider=fpt_marketplace')).total).toBe(5);
    expect((await a.client.get('/api/projects?provider=khong-co')).status).toBe(422);
  });

  it('theo trạng thái tiến trình: đang chạy (gồm đang chờ), có lỗi, không có tiến trình', async () => {
    expect(names(await list(a.client, 'jobState=running&sort=name&order=asc'))).toEqual(['Đang chạy', 'Đang chờ']);
    expect(names(await list(a.client, 'jobState=failed'))).toEqual(['Bị lỗi']);
    expect(names(await list(a.client, 'jobState=none&sort=name&order=asc'))).toEqual(['Chưa có tiến trình', 'Dùng ShopAIKey']);
  });

  it('mỗi mục trả số tiến trình đang chạy và số lỗi', async () => {
    const items = (await list(a.client, 'pageSize=100')).items;
    const by = (n: string) => items.find((i) => i.name === n)!;
    expect(by('Đang chạy')).toMatchObject({ runningJobs: 1, failedJobs: 0 });
    expect(by('Đang chờ')).toMatchObject({ runningJobs: 1, failedJobs: 0 });
    expect(by('Bị lỗi')).toMatchObject({ runningJobs: 0, failedJobs: 1 });
    expect(by('Đã xong')).toMatchObject({ runningJobs: 0, failedJobs: 0 });
  });

  it('kết hợp tìm kiếm + lọc + sắp xếp', async () => {
    expect(names(await list(a.client, 'q=dang&jobState=running&sort=name&order=desc'))).toEqual(['Đang chờ', 'Đang chạy']);
    expect(names(await list(a.client, 'q=dang&provider=shopaikey_openai'))).toEqual([]);
    expect(names(await list(a.client, 'q=shopaikey&provider=shopaikey_openai&jobState=none'))).toEqual(['Dùng ShopAIKey']);
  });
});

describe('phân trang và quy mô', () => {
  it('trả total, page, pageSize đúng; trang cuối ít hơn; vượt trang → rỗng', async () => {
    for (let i = 1; i <= 25; i++) await create(a, `Project ${String(i).padStart(2, '0')}`);
    const p1 = await list(a.client, 'sort=name&order=asc&pageSize=10&page=1');
    const p3 = await list(a.client, 'sort=name&order=asc&pageSize=10&page=3');
    const p4 = await list(a.client, 'sort=name&order=asc&pageSize=10&page=4');
    expect(p1).toMatchObject({ total: 25, page: 1, pageSize: 10 });
    expect(p1.items).toHaveLength(10);
    expect(names(p1)[0]).toBe('Project 01');
    expect(p3.items).toHaveLength(5);
    expect(p4.items).toHaveLength(0);
    expect(p4.total).toBe(25);
  });

  it.each(['page=0', 'page=-1', 'pageSize=0', 'pageSize=101', 'page=abc'])('%s → 422', async (qs) => {
    expect((await a.client.get(`/api/projects?${qs}`)).status).toBe(422);
  });

  it('200 Project: tìm/lọc/sắp xếp trả kết quả trong dưới 1 giây (SC-007)', async () => {
    const db = getDb();
    const rows = Array.from({ length: 200 }, (_, i) => ({
      ownerId: a.id,
      name: `Kịch bản số ${i} về lịch sử và văn hóa`,
      description: i % 3 === 0 ? 'Mô tả có từ khóa đặc biệt' : null,
      providerType: (i % 2 === 0 ? 'shopaikey_openai' : 'fpt_marketplace') as 'shopaikey_openai' | 'fpt_marketplace',
      voiceCount: i % 7,
    }));
    await db.insert(projects).values(rows);
    for (const qs of ['q=kich+ban&sort=name', 'q=dac+biet&provider=shopaikey_openai', 'jobState=none&sort=voiceCount&order=desc', 'sort=updatedAt&pageSize=50']) {
      const t0 = performance.now();
      const page = await list(a.client, qs);
      const ms = performance.now() - t0;
      expect(ms, qs).toBeLessThan(1000);
      expect(page.total).toBeGreaterThan(0);
    }
  });
});

describe('cô lập theo chủ sở hữu', () => {
  it('danh sách và tìm kiếm không bao giờ lộ Project của người khác', async () => {
    const b = await createUser({ name: 'Người khác' });
    await create(a, 'Dự án bí mật của A');
    await create(b, 'Dự án bí mật của B');
    expect(names(await list(a.client, 'q=bi+mat'))).toEqual(['Dự án bí mật của A']);
    expect(names(await list(b.client, 'q=bi+mat'))).toEqual(['Dự án bí mật của B']);
    expect((await list(a.client)).total).toBe(1);
    // đếm theo trạng thái cũng chỉ tính Project của mình
    const bp = (await list(b.client)).items[0]!;
    await addJob(b, bp.id, 'running');
    expect((await list(a.client, 'jobState=running')).total).toBe(0);
    expect(and(eq(projects.ownerId, a.id))).toBeTruthy();
  });
});
