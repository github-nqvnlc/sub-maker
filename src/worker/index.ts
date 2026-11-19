import { runMigrations } from '../lib/db/migrate';
import { closeDb } from '../lib/db';
import { ensureBucket } from '../lib/storage/client';
import { getBoss, stopBoss } from './queues';
import { registerHandlers } from './handlers';
import { startSweeper } from './sweeper';

/**
 * Tiến trình nền (Nguyên tắc III): chạy độc lập với web, xử lý hàng đợi pg-boss.
 * Khởi động: migration (idempotent) → bucket → pg-boss → đăng ký trình xử lý.
 */
async function main() {
  console.log('[worker] đang khởi động…');
  await runMigrations();
  await ensureBucket();
  const boss = await getBoss('worker');
  await registerHandlers(boss);
  // Phục hồi sau sự cố: quét ngay khi khởi động rồi định kỳ (tiến trình treo → gián đoạn → tự tiếp tục)
  const stopSweeper = startSweeper();
  console.log('[worker] sẵn sàng');

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`[worker] nhận ${signal}, đang dừng êm…`);
    try {
      stopSweeper();
      await stopBoss();
      await closeDb();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('[worker] khởi động thất bại:', err instanceof Error ? err.message : err);
  process.exit(1);
});
