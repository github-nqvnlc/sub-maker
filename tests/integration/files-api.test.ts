import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startMockProvider, type MockProvider } from '../../mock-provider/server';
import { getDb } from '@/lib/db';
import { aiProviderConfigs, projects, segments, subtitleFiles, systemSettings, users } from '@/lib/db/schema';
import { headObject } from '@/lib/storage/client';
import { stopBoss } from '@/worker/queues';
import { clearRateLimits, createAdmin, createUser, resetDb, type TestUser } from './helpers';
import { newProject, putGlobalConfig, startJob, uploadScript } from './voice-helpers';

const MB = 1024 * 1024;
let mock: MockProvider;
let admin: TestUser;
let a: TestUser;

const form = (bytes: Uint8Array | string, name: string, type = 'text/plain') => {
  const f = new FormData();
  f.set('file', new File([typeof bytes === 'string' ? bytes : new Uint8Array(bytes)], name, { type }));
  return f;
};
const used = async (id: string) => (await getDb().select().from(users).where(eq(users.id, id)))[0]!.storageUsedBytes;

beforeAll(async () => {
  mock = await startMockProvider();
  await resetDb();
  admin = await createAdmin();
});
afterAll(async () => {
  await mock.close();
  await stopBoss();
});
beforeEach(async () => {
  await clearRateLimits();
  await getDb().delete(aiProviderConfigs);
  await putGlobalConfig(admin, mock, 'ok');
  a = await createUser({ name: 'Người dùng A' });
});

describe('Project (tạo, xem, kiểm tra dữ liệu)', () => {
  it('tạo Project hợp lệ; tên được cắt khoảng trắng; mô tả rỗng thành null', async () => {
    const res = await a.client.post('/api/projects', { json: { name: '  Kênh lịch sử  ', description: '   ', providerType: 'fpt_marketplace' } });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ name: 'Kênh lịch sử', description: null, providerType: 'fpt_marketplace' });
  });

  it.each([
    ['tên rỗng', { name: '', providerType: 'fpt_marketplace' }, 'name'],
    ['tên chỉ khoảng trắng', { name: '    ', providerType: 'fpt_marketplace' }, 'name'],
    ['tên 121 ký tự', { name: 'x'.repeat(121), providerType: 'fpt_marketplace' }, 'name'],
    ['mô tả 2001 ký tự', { name: 'ok', description: 'y'.repeat(2001), providerType: 'fpt_marketplace' }, 'description'],
    ['nhà cung cấp không hợp lệ', { name: 'ok', providerType: 'khong-co' }, 'providerType'],
    ['thiếu nhà cung cấp', { name: 'ok' }, 'providerType'],
    ['trường lạ (ownerId)', { name: 'ok', providerType: 'fpt_marketplace', ownerId: 'x' }, '_'],
  ])('%s → 422', async (_l, json, field) => {
    const res = await a.client.post('/api/projects', { json });
    expect(res.status).toBe(422);
    expect(Object.keys((await res.json()).error.fields)).toContain(field);
  });

  it('biên: tên 120 ký tự và mô tả 2000 ký tự hợp lệ; tên trùng được phép', async () => {
    const body = { name: 'x'.repeat(120), description: 'y'.repeat(2000), providerType: 'fpt_marketplace' };
    expect((await a.client.post('/api/projects', { json: body })).status).toBe(201);
    expect((await a.client.post('/api/projects', { json: body })).status).toBe(201);
  });

  it('chủ sở hữu luôn lấy từ phiên: không thể tạo Project cho người khác', async () => {
    const b = await createUser();
    const res = await a.client.post('/api/projects', { json: { name: 'Của tôi', providerType: 'fpt_marketplace', ownerId: b.id } });
    expect(res.status).toBe(422);
    const id = await newProject(a);
    const [row] = await getDb().select().from(projects).where(eq(projects.id, id));
    expect(row!.ownerId).toBe(a.id);
  });

  it('chi tiết Project gồm files, jobs, voices; User khác nhận 404', async () => {
    const id = await newProject(a);
    await uploadScript(a, id, 'Một dòng đủ dài để đọc.');
    const detail = await (await a.client.get(`/api/projects/${id}`)).json();
    expect(detail).toMatchObject({ id, name: 'Dự án thử' });
    expect(detail.files).toHaveLength(1);
    expect(detail.jobs).toEqual([]);
    expect(detail.voices).toEqual([]);
    const b = await createUser();
    expect((await b.client.get(`/api/projects/${id}`)).status).toBe(404);
    expect((await a.client.get('/api/projects/khong-phai-uuid')).status).toBe(404);
  });
});

describe('upload kịch bản (FR-009, FR-011)', () => {
  it('.txt hợp lệ: trả các đoạn để xem trước, lưu file gốc, tính dung lượng', async () => {
    const pid = await newProject(a);
    const text = 'Chào mừng bạn.\nHôm nay là ngày đẹp trời!';
    const res = await a.client.post(`/api/projects/${pid}/files`, { form: form(text, 'kịch bản.txt') });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ originalName: 'kịch bản.txt', ext: 'txt', segmentCount: 2, rawText: text });
    expect(body.segments).toEqual([
      { idx: 0, text: 'Chào mừng bạn.', charCount: 14 },
      { idx: 1, text: 'Hôm nay là ngày đẹp trời!', charCount: [...'Hôm nay là ngày đẹp trời!'].length },
    ]);
    expect(await used(a.id)).toBe(new TextEncoder().encode(text).length);
    const [row] = await getDb().select().from(subtitleFiles).where(eq(subtitleFiles.id, body.id));
    expect(await headObject(row!.storageKey)).toMatchObject({ size: new TextEncoder().encode(text).length });
  });

  it('.md và .srt được bóc định dạng/mốc thời gian', async () => {
    const pid = await newProject(a);
    const md = await (await a.client.post(`/api/projects/${pid}/files`, { form: form('# Tiêu đề\n\nĐây là **đậm** và [liên kết](https://x.vn).', 'a.md') })).json();
    expect(md.segments.map((s: { text: string }) => s.text)).toEqual(['Tiêu đề', 'Đây là đậm và liên kết.']);
    const srt = await (await a.client.post(`/api/projects/${pid}/files`, { form: form('1\n00:00:01,000 --> 00:00:02,000\nXin chào.\n\n2\n00:00:03,000 --> 00:00:04,000\nTạm biệt.', 'a.srt') })).json();
    expect(srt.segments.map((s: { text: string }) => s.text)).toEqual(['Xin chào.', 'Tạm biệt.']);
  });

  it('GET chi tiết trả văn bản gốc và các đoạn; /raw tải đúng nội dung có Content-Disposition', async () => {
    const pid = await newProject(a);
    const up = await uploadScript(a, pid, 'Nội dung gốc.\nDòng hai.', 'goc.txt');
    const detail = await (await a.client.get(`/api/files/${up.id}`)).json();
    expect(detail.rawText).toBe('Nội dung gốc.\nDòng hai.');
    expect(detail.segments).toHaveLength(2);
    const raw = await a.client.get(`/api/files/${up.id}/raw`);
    expect(raw.status).toBe(200);
    expect(await raw.text()).toBe('Nội dung gốc.\nDòng hai.');
    expect(raw.headers.get('content-disposition')).toContain('attachment');
    expect(raw.headers.get('content-disposition')).toContain('goc.txt');
    const list = await (await a.client.get(`/api/projects/${pid}/files`)).json();
    expect(list).toHaveLength(1);
  });

  it.each([
    ['đuôi .pdf', () => form('xin chào', 'a.pdf'), 422],
    ['đuôi .docx', () => form('xin chào', 'a.docx'), 422],
    ['rỗng', () => form('', 'a.txt'), 422],
    ['chỉ ký hiệu', () => form('😀 --- ...', 'a.txt'), 422],
    ['UTF-8 không hợp lệ', () => form(new Uint8Array([0x41, 0xc3, 0x28]), 'a.txt'), 422],
    ['nhị phân (byte NUL)', () => form(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00, 0x01]), 'a.txt'), 422],
    ['lớn hơn 2 MB', () => form(new Uint8Array(2 * MB + 10).fill(97), 'a.txt'), 413],
  ])('%s → bị từ chối kèm lý do, không tạo gì, không đổi dung lượng', async (_l, make, status) => {
    const pid = await newProject(a);
    const res = await a.client.post(`/api/projects/${pid}/files`, { form: make() });
    expect(res.status).toBe(status);
    const err = (await res.json()).error;
    expect(err.fields.file.length).toBeGreaterThan(5);
    expect(await getDb().select().from(subtitleFiles).where(eq(subtitleFiles.projectId, pid))).toHaveLength(0);
    expect(await used(a.id)).toBe(0);
  });

  it('thiếu trường file → 422', async () => {
    const pid = await newProject(a);
    expect((await a.client.post(`/api/projects/${pid}/files`, { form: new FormData() })).status).toBe(422);
  });

  it('giới hạn kích thước đọc từ cài đặt hệ thống (Administrator chỉnh được)', async () => {
    await getDb().update(systemSettings).set({ value: 100 }).where(eq(systemSettings.key, 'maxFileBytes'));
    try {
      const pid = await newProject(a);
      const res = await a.client.post(`/api/projects/${pid}/files`, { form: form('a'.repeat(101) + '.', 'a.txt') });
      expect(res.status).toBe(413);
      expect((await a.client.post(`/api/projects/${pid}/files`, { form: form('Vừa đủ nhỏ.', 'b.txt') })).status).toBe(201);
    } finally {
      await getDb().update(systemSettings).set({ value: 2097152 }).where(eq(systemSettings.key, 'maxFileBytes'));
    }
  });

  it('vượt hạn mức lưu trữ → 409 QUOTA_EXCEEDED, không lưu gì, không đổi số liệu', async () => {
    const pid = await newProject(a);
    await getDb().update(users).set({ storageUsedBytes: 524288000 - 5 }).where(eq(users.id, a.id));
    const res = await a.client.post(`/api/projects/${pid}/files`, { form: form('Nội dung này lớn hơn 5 byte.', 'a.txt') });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('QUOTA_EXCEEDED');
    expect(await getDb().select().from(subtitleFiles).where(eq(subtitleFiles.projectId, pid))).toHaveLength(0);
    expect(await used(a.id)).toBe(524288000 - 5);
  });

  it('User khác không upload/xem/xóa được file của người khác (404)', async () => {
    const pid = await newProject(a);
    const up = await uploadScript(a, pid, 'Nội dung riêng tư của A.');
    const b = await createUser();
    expect((await b.client.post(`/api/projects/${pid}/files`, { form: form('Xâm nhập.', 'x.txt') })).status).toBe(404);
    expect((await b.client.get(`/api/projects/${pid}/files`)).status).toBe(404);
    expect((await b.client.get(`/api/files/${up.id}`)).status).toBe(404);
    expect((await b.client.get(`/api/files/${up.id}/raw`)).status).toBe(404);
    expect((await b.client.delete(`/api/files/${up.id}`)).status).toBe(404);
  });
});

describe('xóa file', () => {
  it('chưa có tiến trình: xóa được, xóa đối tượng MinIO, các đoạn và trả lại dung lượng', async () => {
    const pid = await newProject(a);
    const up = await uploadScript(a, pid, 'Một dòng sẽ bị xóa.');
    const [row] = await getDb().select().from(subtitleFiles).where(eq(subtitleFiles.id, up.id));
    expect(await used(a.id)).toBeGreaterThan(0);
    expect((await a.client.delete(`/api/files/${up.id}`)).status).toBe(204);
    expect(await headObject(row!.storageKey)).toBeNull();
    expect(await getDb().select().from(segments).where(eq(segments.subtitleFileId, up.id))).toHaveLength(0);
    expect(await used(a.id)).toBe(0);
    expect((await a.client.get(`/api/files/${up.id}`)).status).toBe(404);
  });

  it('còn tiến trình dùng file → 409, không xóa gì (tránh vô tình xóa voice)', async () => {
    const pid = await newProject(a);
    const up = await uploadScript(a, pid, 'Một dòng đang được dùng.');
    await startJob(a, pid, up.id);
    const res = await a.client.delete(`/api/files/${up.id}`);
    expect(res.status).toBe(409);
    expect((await a.client.get(`/api/files/${up.id}`)).status).toBe(200);
  });
});
