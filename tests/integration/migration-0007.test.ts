import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Migration 0007 (spec 004, data-model §7 bước 6, T008a): cấu hình openai_compatible CHUNG được chuyển sang
 * custom_ai_providers (giữ id, chế độ public) và voice job đang trỏ tới nó chuyển sang custom_provider_id.
 * Chạy trên một CSDL tạm: áp migration tới 0006, nạp dữ liệu cũ, rồi áp 0007.
 */
const DB = `submaker_mig_${Date.now().toString(36)}`;
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

  // Bản sao thư mục migration chỉ tới 0006
  dir = await mkdtemp(path.join(os.tmpdir(), 'mig-'));
  await cp(path.resolve(process.cwd(), 'src/lib/db/migrations'), dir, { recursive: true });
  const journalPath = path.join(dir, 'meta/_journal.json');
  const journal = JSON.parse(await readFile(journalPath, 'utf8')) as { entries: Array<{ tag: string }> };
  const full = structuredClone(journal);
  journal.entries = journal.entries.filter((e) => e.tag < '0007');
  await writeFile(journalPath, JSON.stringify(journal));
  await migrate(drizzle(pool), { migrationsFolder: dir });

  // Dữ liệu cũ: User, Project openai_compatible, cấu hình chung openai_compatible, voice job dùng nó
  await pool.query(`insert into users (id, email, display_name) values ('11111111-1111-4111-8111-111111111111', 'old@example.test', 'Cũ')`);
  await pool.query(
    `insert into projects (id, owner_id, name, provider_type) values ('22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111', 'P', 'openai_compatible')`,
  );
  await pool.query(
    `insert into subtitle_files (id, project_id, owner_id, original_name, ext, size_bytes, storage_key, content_hash, char_count, segment_count)
     values ('33333333-3333-4333-8333-333333333333', '22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111', 'a.txt', 'txt', 1, 'k', 'h', 1, 1)`,
  );
  await pool.query(
    `insert into ai_provider_configs (id, scope, type, name, base_url, api_key_enc, api_key_hint, default_model, default_voice, max_chars_per_request)
     values ('44444444-4444-4444-8444-444444444444', 'global', 'openai_compatible', 'OpenAI chung', 'https://api.example.test/v1', '\\x0102', '…abcd', 'tts-1', 'alloy', 4096),
            ('55555555-5555-4555-8555-555555555555', 'global', 'fpt_marketplace', 'FPT', 'https://fpt.example.test/v1', '\\x0304', '…efgh', null, null, 5000)`,
  );
  await pool.query(
    `insert into voice_jobs (id, project_id, owner_id, subtitle_file_id, status, provider_type, config_id, config_scope, settings)
     values ('66666666-6666-4666-8666-666666666666', '22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111', '33333333-3333-4333-8333-333333333333', 'queued', 'openai_compatible', '44444444-4444-4444-8444-444444444444', 'global', '{"voice":"alloy"}')`,
  );

  // Áp 0007
  await writeFile(journalPath, JSON.stringify(full));
  await migrate(drizzle(pool), { migrationsFolder: dir });
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await admin?.query(`DROP DATABASE IF EXISTS "${DB}" WITH (FORCE)`);
  await admin?.end();
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('migration 0007', () => {
  it('chuyển cấu hình openai_compatible chung sang custom_ai_providers (public, giữ id và khóa)', async () => {
    const { rows } = await pool.query(`select id, name, base_url, api_key_hint, models, default_model, access_mode from custom_ai_providers`);
    expect(rows).toEqual([
      {
        id: '44444444-4444-4444-8444-444444444444',
        name: 'OpenAI chung',
        base_url: 'https://api.example.test/v1',
        api_key_hint: '…abcd',
        models: ['tts-1'],
        default_model: 'tts-1',
        access_mode: 'public',
      },
    ]);
    const left = await pool.query(`select type from ai_provider_configs order by type`);
    expect(left.rows.map((r: { type: string }) => r.type)).toEqual(['fpt_marketplace']);
  });

  it('voice job đang trỏ tới cấu hình đó chuyển sang custom_provider_id', async () => {
    const { rows } = await pool.query(`select config_id, custom_provider_id from voice_jobs`);
    expect(rows).toEqual([{ config_id: null, custom_provider_id: '44444444-4444-4444-8444-444444444444' }]);
  });

  it('enum provider_type có soniox; bảng STT và cột usage mới tồn tại', async () => {
    const e = await pool.query(`select unnest(enum_range(null::provider_type))::text as v`);
    expect(e.rows.map((r: { v: string }) => r.v)).toContain('soniox');
    const cols = await pool.query(`select column_name from information_schema.columns where table_name = 'usage_records'`);
    expect(cols.rows.map((r: { column_name: string }) => r.column_name)).toEqual(expect.arrayContaining(['units_audio_seconds', 'stt_job_id']));
    const t = await pool.query(`select to_regclass('stt_jobs') as a, to_regclass('stt_job_logs') as b, to_regclass('stt_provider_configs') as c`);
    expect(t.rows[0]).toEqual({ a: 'stt_jobs', b: 'stt_job_logs', c: 'stt_provider_configs' });
  });
});
