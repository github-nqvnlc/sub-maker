import { eq, sql } from 'drizzle-orm';
import { getDb, type Db } from '../db';
import { users } from '../db/schema';
import { HttpError } from '../api/errors';
import { getSettings } from '../settings';

/**
 * Hạn mức lưu trữ mỗi User (FR-046, data-model R16). Hai chế độ:
 * - **chặt** (mặc định): từ chối khi vượt hạn mức; dùng lúc upload file và lúc tạo job mới.
 * - **mềm** (`soft: true`): luôn cho phép và chỉ cộng số liệu; dùng trong worker để job đang chạy
 *   không bao giờ bị hủy vì vượt hạn mức.
 * Mọi cập nhật là một câu UPDATE nguyên tử nên an toàn khi nhiều tiến trình ghi đồng thời.
 */

export class QuotaExceededError extends HttpError {
  constructor() {
    super(409, 'QUOTA_EXCEEDED');
    this.name = 'QuotaExceededError';
  }
}

export async function reserveBytes(
  userId: string,
  bytes: number,
  opts: { soft?: boolean; db?: Db } = {},
): Promise<void> {
  if (bytes <= 0) return;
  const db = opts.db ?? getDb();
  if (opts.soft) {
    await db
      .update(users)
      .set({ storageUsedBytes: sql`${users.storageUsedBytes} + ${bytes}` })
      .where(eq(users.id, userId));
    return;
  }
  const { userQuotaBytes } = await getSettings(db);
  const updated = await db
    .update(users)
    .set({ storageUsedBytes: sql`${users.storageUsedBytes} + ${bytes}` })
    .where(sql`${users.id} = ${userId} and ${users.storageUsedBytes} + ${bytes} <= ${userQuotaBytes}`)
    .returning({ id: users.id });
  if (updated.length === 0) throw new QuotaExceededError();
}

export async function releaseBytes(userId: string, bytes: number, db: Db = getDb()): Promise<void> {
  if (bytes <= 0) return;
  await db
    .update(users)
    .set({ storageUsedBytes: sql`greatest(0, ${users.storageUsedBytes} - ${bytes})` })
    .where(eq(users.id, userId));
}

/** Kiểm tra User còn chỗ cho ít nhất `bytes` (dùng trước khi tạo job mới). Không thay đổi số liệu. */
export async function hasQuotaFor(userId: string, bytes: number, db: Db = getDb()): Promise<boolean> {
  const { userQuotaBytes } = await getSettings(db);
  const [row] = await db.select({ used: users.storageUsedBytes }).from(users).where(eq(users.id, userId)).limit(1);
  return !!row && row.used + bytes <= userQuotaBytes;
}
