/**
 * Chạy một lần khi máy chủ web khởi động: migration, bucket riêng tư, seed Administrator.
 * Chỉ chạy ở runtime Node.js (không chạy lúc build hay ở Edge).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (process.env.NEXT_PHASE === 'phase-production-build') return;
  if (!process.env.DATABASE_URL) return; // chưa cấu hình (ví dụ chạy lint/typecheck)

  const { runMigrations } = await import('./lib/db/migrate');
  const { ensureBucket } = await import('./lib/storage/client');
  const { seedAdmin } = await import('./lib/auth/seed-admin');

  await runMigrations();
  await ensureBucket();
  const result = await seedAdmin();
  console.log(
    `[startup] Administrator: ${result.created ? 'đã tạo' : result.passwordUpdated ? 'đã đồng bộ mật khẩu' : 'đã sẵn sàng'}`,
  );
}
