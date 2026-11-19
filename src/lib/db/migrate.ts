import path from 'node:path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { closeDb, getDb, getPool } from './index';
import { seedSystemSettings } from './seed';

/** Khóa tư vấn dùng để các tiến trình (web, worker, dịch vụ migrate) không chạy migration cùng lúc. */
const MIGRATION_LOCK = 727_002;

/**
 * Chạy toàn bộ migration rồi seed cài đặt hệ thống mặc định (idempotent).
 * Tuần tự hóa bằng khóa tư vấn: web và worker có thể khởi động đồng thời trên CSDL trống mà không tranh nhau
 * tạo bảng (tiến trình đến sau chờ rồi thấy mọi migration đã áp dụng).
 */
export async function runMigrations(): Promise<void> {
  const lockConn = await getPool().connect();
  try {
    await lockConn.query('select pg_advisory_lock($1)', [MIGRATION_LOCK]);
    const db = getDb();
    await migrate(db, { migrationsFolder: path.resolve(process.cwd(), 'src/lib/db/migrations') });
    await seedSystemSettings(db);
  } finally {
    try {
      await lockConn.query('select pg_advisory_unlock($1)', [MIGRATION_LOCK]);
    } finally {
      lockConn.release();
    }
  }
}

const entry = process.argv[1]?.replaceAll('\\', '/') ?? '';
if (entry.endsWith('src/lib/db/migrate.ts')) {
  runMigrations()
    .then(async () => {
      console.log('[db] migration hoàn tất');
      await closeDb();
    })
    .catch(async (err) => {
      console.error('[db] migration thất bại:', err);
      await closeDb();
      process.exit(1);
    });
}
