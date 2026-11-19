import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema';

export type Db = NodePgDatabase<typeof schema>;

type Holder = { pool?: pg.Pool; db?: Db; url?: string };
const g = globalThis as unknown as { __submakerDb?: Holder };
const holder: Holder = (g.__submakerDb ??= {});

/** Kết nối dùng chung (singleton theo tiến trình; giữ qua hot-reload của Next ở dev). */
export function getPool(): pg.Pool {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('Thiếu biến môi trường DATABASE_URL');
  if (holder.pool && holder.url !== url) {
    // URL đổi (ví dụ kiểm thử chuyển sang CSDL test): tạo pool mới
    void holder.pool.end().catch(() => undefined);
    holder.pool = undefined;
    holder.db = undefined;
  }
  if (!holder.pool) {
    holder.pool = new pg.Pool({ connectionString: url, max: 10 });
    holder.url = url;
    holder.pool.on('error', (err) => console.error('[db] pool error:', err.message));
  }
  return holder.pool;
}

export function getDb(): Db {
  if (!holder.db || holder.url !== process.env.DATABASE_URL) {
    holder.db = drizzle(getPool(), { schema });
  }
  return holder.db;
}

export async function closeDb(): Promise<void> {
  if (holder.pool) {
    await holder.pool.end();
    holder.pool = undefined;
    holder.db = undefined;
  }
}

export { schema };
