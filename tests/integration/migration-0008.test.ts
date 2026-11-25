import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Migration 0008 (spec 005, T008): bảng video overlay. Chạy trên CSDL tạm đã có dữ liệu ở 0007, rồi kiểm từng ràng buộc.
 */
const DB = `submaker_mig8_${Date.now().toString(36)}`;
const USER = '11111111-1111-4111-8111-111111111111';
const PROJECT = '22222222-2222-4222-8222-222222222222';
const FILE = '33333333-3333-4333-8333-333333333333';
const VJOB = '44444444-4444-4444-8444-444444444444';
const VOICE = '55555555-5555-4555-8555-555555555555';
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

  dir = await mkdtemp(path.join(os.tmpdir(), 'mig8-'));
  await cp(path.resolve(process.cwd(), 'src/lib/db/migrations'), dir, { recursive: true });
  const journalPath = path.join(dir, 'meta/_journal.json');
  const journal = JSON.parse(await readFile(journalPath, 'utf8')) as { entries: Array<{ tag: string }> };
  const full = structuredClone(journal);
  journal.entries = journal.entries.filter((e) => e.tag < '0008');
  await writeFile(journalPath, JSON.stringify(journal));
  await migrate(drizzle(pool), { migrationsFolder: dir });

  await pool.query(`insert into users (id, email, display_name) values ('${USER}', 'old@example.test', 'Cũ')`);
  await pool.query(`insert into projects (id, owner_id, name, provider_type) values ('${PROJECT}', '${USER}', 'P', 'fpt_marketplace')`);
  await pool.query(
    `insert into subtitle_files (id, project_id, owner_id, original_name, ext, size_bytes, storage_key, content_hash, char_count, segment_count)
     values ('${FILE}', '${PROJECT}', '${USER}', 'a.srt', 'srt', 1, 'k', 'h', 1, 1)`,
  );
  await pool.query(
    `insert into voice_jobs (id, project_id, owner_id, subtitle_file_id, status, provider_type, config_scope, settings)
     values ('${VJOB}', '${PROJECT}', '${USER}', '${FILE}', 'completed', 'fpt_marketplace', 'global', '{"voice":"x"}')`,
  );
  await pool.query(
    `insert into voices (id, project_id, owner_id, job_id, subtitle_file_id, title, storage_key, duration_ms, size_bytes, timeline)
     values ('${VOICE}', '${PROJECT}', '${USER}', '${VJOB}', '${FILE}', 'V', 'k2', 1000, 10, '[]')`,
  );

  await writeFile(journalPath, JSON.stringify(full));
  await migrate(drizzle(pool), { migrationsFolder: dir });
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await admin?.query(`DROP DATABASE IF EXISTS "${DB}" WITH (FORCE)`);
  await admin?.end();
  if (dir) await rm(dir, { recursive: true, force: true });
});

const job = (over: Record<string, unknown> = {}) => {
  const row: Record<string, unknown> = {
    id: randomUUID(),
    project_id: PROJECT,
    owner_id: USER,
    client_request_id: randomUUID(),
    voice_id: VOICE,
    subtitle_file_id: FILE,
    source_names: '{"voice":"V","subtitle":"a.srt"}',
    config: '{}',
    cues: '[]',
    engine_version: 1,
    format: 'mp4',
    width: 1080,
    height: 1920,
    duration_ms: 1000,
    estimated_bytes: 1000,
    ...over,
  };
  const keys = Object.keys(row);
  return pool.query(`insert into overlay_jobs (${keys.join(',')}) values (${keys.map((_, i) => `$${i + 1}`).join(',')}) returning *`, Object.values(row));
};
const audio = (over: Record<string, unknown> = {}) => {
  const row: Record<string, unknown> = { id: randomUUID(), project_id: PROJECT, owner_id: USER, original_name: 'a.mp3', ...over };
  const keys = Object.keys(row);
  return pool.query(`insert into overlay_audios (${keys.join(',')}) values (${keys.map((_, i) => `$${i + 1}`).join(',')}) returning *`, Object.values(row));
};

describe('migration 0008', () => {
  it('dữ liệu cũ còn nguyên, bảng mới có giá trị mặc định đúng', async () => {
    expect((await pool.query('select count(*)::int n from voices')).rows[0].n).toBe(1);
    const r = (await job()).rows[0];
    expect(r).toMatchObject({ status: 'queued', progress_percent: 0, attempt: 0, interruptions: 0, cancel_requested: false, warnings: [], output_storage_key: null });
    const a = (await audio()).rows[0];
    expect(a).toMatchObject({ status: 'processing', size_bytes: '0', interruptions: 0, duration_ms: null });
    const c = (await pool.query(`insert into overlay_configs (project_id, owner_id, config) values ('${PROJECT}', '${USER}', '{}') returning *`)).rows[0];
    expect(c.source).toEqual({});
  });

  it('ràng buộc của overlay_jobs', async () => {
    const id = randomUUID();
    await job({ client_request_id: id });
    await expect(job({ client_request_id: id })).rejects.toThrow(/overlay_jobs_owner_request_uq/);
    await expect(job({ duration_ms: 0 })).rejects.toThrow(/overlay_jobs_duration_pos/);
    await expect(job({ estimated_bytes: 0 })).rejects.toThrow(/overlay_jobs_estimate_pos/);
    await expect(job({ progress_percent: 101 })).rejects.toThrow(/overlay_jobs_progress_range/);
    await expect(job({ format: 'gif' })).rejects.toThrow(/overlay_format/);
    await expect(job({ status: 'completed' })).rejects.toThrow(/overlay_jobs_completed_has_output/);
    await expect(job({ status: 'failed', output_storage_key: 'k', output_size_bytes: 5 })).rejects.toThrow(/overlay_jobs_completed_has_output/);
    await expect(job({ status: 'completed', output_storage_key: 'k', output_size_bytes: 0 })).rejects.toThrow(/overlay_jobs_output_pos/);
    // dung lượng lớn hơn giới hạn số nguyên 32 bit
    expect((await job({ status: 'completed', output_storage_key: 'k', output_size_bytes: 3_000_000_000, estimated_bytes: 4_000_000_000 })).rowCount).toBe(1);
  });

  it('ràng buộc của overlay_audios', async () => {
    await expect(audio({ original_name: '' })).rejects.toThrow(/overlay_audios_name_len/);
    await expect(audio({ original_name: 'x'.repeat(256) })).rejects.toThrow(/overlay_audios_name_len/);
    await expect(audio({ size_bytes: -1 })).rejects.toThrow(/overlay_audios_size_nonneg/);
    await expect(audio({ duration_ms: 0 })).rejects.toThrow(/overlay_audios_duration_pos/);
    await expect(audio({ status: 'ready' })).rejects.toThrow(/overlay_audios_ready/);
    await expect(audio({ status: 'ready', duration_ms: 10 })).rejects.toThrow(/overlay_audios_ready/);
    expect((await audio({ status: 'ready', duration_ms: 10, storage_key: 'k' })).rowCount).toBe(1);
  });

  it('xóa nguồn đặt NULL, xóa Project xóa hết', async () => {
    const a = (await audio({ status: 'ready', duration_ms: 10, storage_key: 'k' })).rows[0].id as string;
    const j = (await job({ voice_id: null, audio_id: a })).rows[0].id as string;
    await pool.query(`insert into overlay_job_logs (job_id, level, message_key) values ($1, 'info', 'started')`, [j]);
    await pool.query('delete from overlay_audios where id = $1', [a]);
    expect((await pool.query('select audio_id from overlay_jobs where id = $1', [j])).rows[0].audio_id).toBeNull();
    await pool.query('delete from voices where id = $1', [VOICE]);
    expect((await pool.query('select count(*)::int n from overlay_jobs where voice_id is not null')).rows[0].n).toBe(0);
    await pool.query('delete from projects where id = $1', [PROJECT]);
    for (const t of ['overlay_jobs', 'overlay_audios', 'overlay_configs', 'overlay_job_logs']) expect((await pool.query(`select count(*)::int n from ${t}`)).rows[0].n).toBe(0);
  });
});
