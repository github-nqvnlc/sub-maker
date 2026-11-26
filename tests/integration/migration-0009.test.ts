import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Migration 0009 (spec 006, T008): bảng dịch video. Chạy trên CSDL tạm đã có dữ liệu ở 0008, rồi kiểm giá trị mặc định và từng ràng buộc.
 */
const DB = `submaker_mig9_${Date.now().toString(36)}`;
const USER = '11111111-1111-4111-8111-111111111111';
const PROJECT = '22222222-2222-4222-8222-222222222222';
let admin: pg.Client;
let pool: pg.Pool;
let dir: string;

beforeAll(async () => {
  const base = new URL(process.env.DEV_DATABASE_URL ?? process.env.DATABASE_URL!);
  const adminUrl = new URL(base);
  adminUrl.pathname = '/postgres';
  admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${DB}"`);
  const url = new URL(base);
  url.pathname = `/${DB}`;
  pool = new pg.Pool({ connectionString: url.toString() });

  dir = await mkdtemp(path.join(os.tmpdir(), 'mig9-'));
  await cp(path.resolve(process.cwd(), 'src/lib/db/migrations'), dir, { recursive: true });
  const journalPath = path.join(dir, 'meta/_journal.json');
  const journal = JSON.parse(await readFile(journalPath, 'utf8')) as { entries: Array<{ tag: string }> };
  const full = structuredClone(journal);
  journal.entries = journal.entries.filter((e) => e.tag < '0009');
  await writeFile(journalPath, JSON.stringify(journal));
  await migrate(drizzle(pool), { migrationsFolder: dir });

  await pool.query(`insert into users (id, email, display_name, storage_used_bytes) values ('${USER}', 'old@example.test', 'Cũ', 123)`);
  await pool.query(`insert into projects (id, owner_id, name, provider_type) values ('${PROJECT}', '${USER}', 'P', 'fpt_marketplace')`);
  await pool.query(`insert into usage_records (user_id, project_id, provider_type, config_scope, units_chars, ok) values ('${USER}', '${PROJECT}', 'fpt_marketplace', 'global', 5, true)`);

  await writeFile(journalPath, JSON.stringify(full));
  await migrate(drizzle(pool), { migrationsFolder: dir });
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await admin?.query(`DROP DATABASE IF EXISTS "${DB}" WITH (FORCE)`);
  await admin?.end();
  if (dir) await rm(dir, { recursive: true, force: true });
});

function insert(table: string, row: Record<string, unknown>) {
  const keys = Object.keys(row);
  return pool.query(`insert into ${table} (${keys.join(',')}) values (${keys.map((_, i) => `$${i + 1}`).join(',')}) returning *`, Object.values(row));
}
const job = (over: Record<string, unknown> = {}) =>
  insert('video_jobs', { id: randomUUID(), project_id: PROJECT, owner_id: USER, original_file_name: 'a.mp4', ext: 'mp4', file_size_bytes: 10, fingerprint: 'f', direction: 'to_vi', ...over });
const newJobId = async () => (await job()).rows[0].id as string;
const upload = (jobId: string, over: Record<string, unknown> = {}) =>
  insert('video_uploads', {
    job_id: jobId,
    owner_id: USER,
    kind: 'source',
    storage_upload_id: 's',
    key: 'k',
    size_bytes: 10,
    part_size: 16 * 1024 * 1024,
    part_count: 1,
    fingerprint: 'f',
    expires_at: new Date(Date.now() + 3600_000),
    ...over,
  });
const cue = (jobId: string, over: Record<string, unknown> = {}) => insert('video_cues', { job_id: jobId, start_ms: 0, end_ms: 1000, timing: 'measured', ...over });
const exportRow = (jobId: string, over: Record<string, unknown> = {}) =>
  insert('video_exports', { job_id: jobId, owner_id: USER, kind: 'burn', format: 'mp4', style: '{}', cues: '[]', cue_revision: 0, estimated_bytes: 100, duration_ms: 1000, ...over });

describe('migration 0009', () => {
  it('dữ liệu cũ còn nguyên, cột và bảng mới có giá trị mặc định đúng', async () => {
    const u = (await pool.query('select * from users where id = $1', [USER])).rows[0];
    expect(u).toMatchObject({ storage_used_bytes: '123', can_translate_video: false, video_used_bytes: '0' });
    expect((await pool.query('select video_job_id from usage_records')).rows).toEqual([{ video_job_id: null }]);

    const j = (await job()).rows[0];
    expect(j).toMatchObject({
      status: 'waiting_media',
      source_state: 'uploading',
      preview_state: 'none',
      progress_percent: 0,
      client_audio: false,
      audio_mismatch: false,
      cancel_requested: false,
      attempt: 0,
      interruptions: 0,
      preview_attempt: 0,
      translation_run: 1,
      billed_run: 0,
      cue_run: 0,
      cue_revision: 0,
      cue_count: 0,
      script_bytes: '0',
      glossary: [],
      source_key: null,
      source_expires_at: null,
      media: null,
      style: null,
    });
    expect(j.last_activity_at).toBeInstanceOf(Date);

    const s = (await insert('video_project_settings', { project_id: PROJECT, owner_id: USER })).rows[0];
    expect(s).toMatchObject({ direction: 'to_vi', glossary: [], style: null });
    const e = (await exportRow(j.id)).rows[0];
    expect(e).toMatchObject({ status: 'queued', progress_percent: 50, cancel_requested: false, attempt: 0, interruptions: 0, output_key: null, expires_at: null });
    const up = (await upload(j.id)).rows[0];
    expect(up.state).toBe('active');
    const c = (await cue(j.id)).rows[0];
    expect(c).toMatchObject({ source_text: '', target_text: '', flags: {} });
  });

  it('ràng buộc của video_jobs', async () => {
    await expect(job({ original_file_name: '' })).rejects.toThrow(/video_jobs_name_len/);
    await expect(job({ original_file_name: 'x'.repeat(256) })).rejects.toThrow(/video_jobs_name_len/);
    await expect(job({ ext: 'gif' })).rejects.toThrow(/video_jobs_ext/);
    await expect(job({ file_size_bytes: 0 })).rejects.toThrow(/video_jobs_size_pos/);
    await expect(job({ direction: 'x' })).rejects.toThrow(/video_jobs_direction/);
    await expect(job({ source_state: 'x' })).rejects.toThrow(/video_jobs_source_state/);
    await expect(job({ preview_state: 'x' })).rejects.toThrow(/video_jobs_preview_state/);
    await expect(job({ progress_percent: 51 })).rejects.toThrow(/video_jobs_progress_range/);
    await expect(job({ script_bytes: -1 })).rejects.toThrow(/video_jobs_script_nonneg/);
    await expect(job({ cue_count: 20_001 })).rejects.toThrow(/video_jobs_cue_count_range/);
    await expect(job({ status: 'x' })).rejects.toThrow(/video_job_status/);
    // dung lượng 10 GB vượt số nguyên 32 bit
    expect((await job({ file_size_bytes: 10 * 1024 ** 3 })).rows[0].file_size_bytes).toBe(String(10 * 1024 ** 3));
    await expect(pool.query('update users set video_used_bytes = -1')).rejects.toThrow(/users_video_storage_nonneg/);
    await expect(insert('video_project_settings', { project_id: randomUUID(), owner_id: USER })).rejects.toThrow(/foreign key/);
  });

  it('mỗi (việc, loại) nhiều nhất một phiên tải đang mở; phần gửi lại trùng khóa chính', async () => {
    const id = await newJobId();
    const first = (await upload(id)).rows[0].id as string;
    await expect(upload(id)).rejects.toThrow(/video_uploads_open_uq/);
    await expect(upload(id, { state: 'completing' })).rejects.toThrow(/video_uploads_open_uq/);
    expect((await upload(id, { kind: 'client_audio' })).rowCount).toBe(1);
    expect((await upload(id, { state: 'aborted' })).rowCount).toBe(1);
    await pool.query(`update video_uploads set state = 'completed' where id = $1`, [first]);
    expect((await upload(id)).rowCount).toBe(1);
    await expect(upload(id, { kind: 'x' })).rejects.toThrow(/video_uploads_kind/);
    await expect(upload(id, { state: 'x' })).rejects.toThrow(/video_uploads_state/);
    await expect(upload(id, { part_count: 10_001, state: 'aborted' })).rejects.toThrow(/video_uploads_parts_range/);
    await insert('video_upload_parts', { upload_id: first, n: 1, size: 1, etag: 'e', sha256: 'h' });
    await expect(insert('video_upload_parts', { upload_id: first, n: 1, size: 1, etag: 'e', sha256: 'h' })).rejects.toThrow(/video_upload_parts_pk/);
    await expect(insert('video_upload_parts', { upload_id: first, n: 0, size: 1, etag: 'e', sha256: 'h' })).rejects.toThrow(/video_upload_parts_n/);
  });

  it('ràng buộc của cue; cùng id ở hai việc khác nhau không đụng nhau', async () => {
    const a = await newJobId();
    const b = await newJobId();
    const id = randomUUID();
    await cue(a, { id });
    expect((await cue(b, { id })).rowCount).toBe(1);
    await expect(cue(a, { id })).rejects.toThrow(/video_cues_pk/);
    await expect(cue(a, { start_ms: -1 })).rejects.toThrow(/video_cues_time/);
    await expect(cue(a, { start_ms: 0, end_ms: 99 })).rejects.toThrow(/video_cues_time/);
    await expect(cue(a, { timing: 'x' })).rejects.toThrow(/video_cues_timing/);
    await expect(cue(a, { target_text: 'x'.repeat(2001) })).rejects.toThrow(/video_cues_text_len/);
    await expect(cue(a, { source_text: 'x'.repeat(2001) })).rejects.toThrow(/video_cues_text_len/);
  });

  it('ràng buộc của bản xuất', async () => {
    const id = await newJobId();
    const first = (await exportRow(id)).rows[0].id as string;
    await expect(exportRow(id)).rejects.toThrow(/video_exports_open_uq/);
    await expect(exportRow(id, { status: 'interrupted' })).rejects.toThrow(/video_exports_open_uq/);
    expect((await exportRow(id, { status: 'failed' })).rowCount).toBe(1);
    await pool.query(`update video_exports set status = 'stopped' where id = $1`, [first]);
    await expect(exportRow(id, { kind: 'x', status: 'failed' })).rejects.toThrow(/video_exports_(kind|format)/);
    await expect(exportRow(id, { format: 'mov', status: 'failed' })).rejects.toThrow(/video_exports_format/);
    expect((await exportRow(id, { kind: 'layer', format: 'mov', status: 'failed' })).rowCount).toBe(1);
    await expect(exportRow(id, { progress_percent: 49, status: 'failed' })).rejects.toThrow(/video_exports_progress_range/);
    await expect(exportRow(id, { estimated_bytes: 0, status: 'failed' })).rejects.toThrow(/video_exports_estimate_pos/);
    await expect(exportRow(id, { duration_ms: 0, status: 'failed' })).rejects.toThrow(/video_exports_duration_pos/);
    await expect(exportRow(id, { status: 'completed' })).rejects.toThrow(/video_exports_completed_has_output/);
    await expect(exportRow(id, { status: 'completed', output_key: 'k', output_bytes: 0, expires_at: new Date() })).rejects.toThrow(/video_exports_output_pos/);
    expect((await exportRow(id, { status: 'completed', output_key: 'k', output_bytes: 6 * 1024 ** 3, expires_at: new Date() })).rowCount).toBe(1);
  });

  it('xóa việc xóa sạch dữ liệu con và giữ bản ghi sử dụng; xóa Project xóa hết', async () => {
    const id = await newJobId();
    const up = (await upload(id)).rows[0].id as string;
    await insert('video_upload_parts', { upload_id: up, n: 1, size: 1, etag: 'e', sha256: 'h' });
    await cue(id);
    const ex = (await exportRow(id)).rows[0].id as string;
    await insert('video_job_logs', { job_id: id, export_id: ex, level: 'info', message_key: 'queued' });
    await insert('usage_records', { user_id: USER, project_id: PROJECT, video_job_id: id, provider_type: 'soniox', config_scope: 'global', units_audio_seconds: 3, ok: true });
    await pool.query('delete from video_jobs where id = $1', [id]);
    for (const [table, column] of [
      ['video_uploads', 'job_id'],
      ['video_cues', 'job_id'],
      ['video_exports', 'job_id'],
      ['video_job_logs', 'job_id'],
    ]) {
      expect((await pool.query(`select count(*)::int n from ${table} where ${column} = $1`, [id])).rows[0].n).toBe(0);
    }
    expect((await pool.query('select count(*)::int n from video_upload_parts where upload_id = $1', [up])).rows[0].n).toBe(0);
    expect((await pool.query('select count(*)::int n from usage_records where units_audio_seconds = 3 and video_job_id is null')).rows[0].n).toBe(1);
    await pool.query('delete from projects where id = $1', [PROJECT]);
    for (const t of ['video_jobs', 'video_project_settings', 'video_cues', 'video_exports', 'video_uploads']) {
      expect((await pool.query(`select count(*)::int n from ${t}`)).rows[0].n).toBe(0);
    }
  });
});
