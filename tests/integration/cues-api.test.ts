import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '@/lib/db';
import { subtitleCues, subtitleFiles } from '@/lib/db/schema';
import { TestClient, clearRateLimits, createUser, resetDb, type TestUser } from './helpers';
import { newProject, uploadScript } from './voice-helpers';

const fixture = (name: string) => fs.readFileSync(path.resolve(process.cwd(), 'tests/fixtures', name), 'utf8');

let a: TestUser;
let b: TestUser;

beforeAll(async () => {
  await resetDb();
});
beforeEach(async () => {
  await clearRateLimits();
  a = await createUser({ name: 'Người A' });
  b = await createUser({ name: 'Người B' });
});

async function upload(user: TestUser, name: string, text: string) {
  const projectId = await newProject(user);
  const file = await uploadScript(user, projectId, text, name);
  return { projectId, file: file as unknown as { id: string; hasTimecodes: boolean; cueCount: number | null; durationMs: number | null; warningCount: number } };
}

describe('tải .srt có mốc → lưu cue (spec 003, FR-001/FR-002/FR-011)', () => {
  it('ghi has_timecodes, cue_count, duration_ms và 3 hàng subtitle_cues', async () => {
    const { file } = await upload(a, 'sample-10s.srt', fixture('sample-10s.srt'));
    expect(file).toMatchObject({ hasTimecodes: true, cueCount: 3, durationMs: 9772, warningCount: 0 });

    const row = (await getDb().select().from(subtitleFiles).where(eq(subtitleFiles.id, file.id)))[0]!;
    expect(row).toMatchObject({ hasTimecodes: true, cueCount: 3, durationMs: 9772, cueWarningCount: 0 });
    const cues = await getDb().select().from(subtitleCues).where(eq(subtitleCues.subtitleFileId, file.id));
    expect(cues).toHaveLength(3);
    expect(cues.map((c) => c.text).sort()).toEqual(
      ['Bạn đã nghe hai bài phát biểu ở Thẩm Quyến ngày 18 tháng 11.', 'Không Putin.', 'Nhưng Tập Cận Bình không nhắc đến Nga một lần nào.'].sort(),
    );
    // vẫn có đoạn cho chế độ "Đọc liên tục"
    expect(row.segmentCount).toBeGreaterThan(0);
  });

  it('GET /cues phân trang đúng và không chứa số thứ tự/mốc trong chữ', async () => {
    const { file } = await upload(a, 'sample-synthetic.srt', fixture('sample-synthetic.srt'));
    const p1 = await (await a.client.get(`/api/files/${file.id}/cues?page=1&pageSize=5`)).json();
    expect(p1).toMatchObject({ total: 12, page: 1, pageSize: 5 });
    expect(p1.items).toHaveLength(5);
    expect(p1.items.map((c: { idx: number }) => c.idx)).toEqual([0, 1, 2, 3, 4]);
    const p3 = await (await a.client.get(`/api/files/${file.id}/cues?page=3&pageSize=5`)).json();
    expect(p3.items.map((c: { idx: number }) => c.idx)).toEqual([10, 11]);
    for (const c of p1.items) expect(c.text).not.toMatch(/-->/);
    // cue ♪ là NO_SPEECH: không đọc, có cảnh báo
    expect(p1.items[2]).toMatchObject({ speakable: false, text: '', charCount: 0 });
    expect(p1.warnings).toContainEqual({ cue: 3, code: 'NO_SPEECH' });
    expect(p1.warningCount).toBe(1);
  });

  it('tham số trang sai → 422', async () => {
    const { file } = await upload(a, 'sample-10s.srt', fixture('sample-10s.srt'));
    expect((await a.client.get(`/api/files/${file.id}/cues?page=0`)).status).toBe(422);
    expect((await a.client.get(`/api/files/${file.id}/cues?pageSize=201`)).status).toBe(422);
  });

  it('tệp .txt → 409 NO_TIMECODES', async () => {
    const { file } = await upload(a, 'kich-ban.txt', 'Một câu.\nHai câu.');
    expect(file.hasTimecodes).toBe(false);
    const res = await a.client.get(`/api/files/${file.id}/cues`);
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('NO_TIMECODES');
  });

  it('.srt không có mốc hợp lệ cũng coi như không có mốc', async () => {
    const { file } = await upload(a, 'khong-moc.srt', 'Chỉ là văn bản.\nKhông có mốc.');
    expect(file.hasTimecodes).toBe(false);
    expect((await a.client.get(`/api/files/${file.id}/cues`)).status).toBe(409);
  });

  it('tệp .skt bị từ chối', async () => {
    const projectId = await newProject(a);
    const form = new FormData();
    form.set('file', new File([fixture('sample-10s.srt')], 'cu.skt', { type: 'text/plain' }));
    const res = await a.client.post(`/api/projects/${projectId}/files`, { form });
    expect(res.status).toBe(422);
  });
});

describe('cô lập dữ liệu (Nguyên tắc I)', () => {
  it('chưa đăng nhập → 401; người dùng khác → 404', async () => {
    const { file } = await upload(a, 'sample-10s.srt', fixture('sample-10s.srt'));
    expect((await new TestClient().get(`/api/files/${file.id}/cues`)).status).toBe(401);
    expect((await b.client.get(`/api/files/${file.id}/cues`)).status).toBe(404);
  });
});

describe('xóa sạch dữ liệu', () => {
  it('xóa tệp / Project / User kéo theo xóa subtitle_cues', async () => {
    const one = await upload(a, 'sample-10s.srt', fixture('sample-10s.srt'));
    expect((await a.client.delete(`/api/files/${one.file.id}`)).status).toBe(204);
    expect(await getDb().select().from(subtitleCues).where(eq(subtitleCues.subtitleFileId, one.file.id))).toHaveLength(0);

    const two = await upload(a, 'sample-10s.srt', fixture('sample-10s.srt'));
    expect((await a.client.delete(`/api/projects/${two.projectId}`)).status).toBeLessThan(300);
    // giữ nguyên: sau khi xóa Project, các cue không còn (cascade)
    const left = await getDb().select().from(subtitleCues).where(eq(subtitleCues.subtitleFileId, two.file.id));
    expect(left).toHaveLength(0);
  });
});
