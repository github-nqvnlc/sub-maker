import { and, eq, sql } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import { getDb } from '../../lib/db';
import { users, voiceJobs } from '../../lib/db/schema';
import { deleteByPrefix } from '../../lib/storage/client';
import { storageKeys } from '../../lib/storage/keys';
import { stopAllForUser } from '../../lib/jobs/control';
import { QUEUES, type DeleteUserPayload } from '../queues';

/**
 * Xóa vĩnh viễn dữ liệu của một User (FR-037, research R17). IDEMPOTENT và an toàn khi thử lại:
 *  1. đặt `deleting` (chặn đăng nhập), yêu cầu dừng mọi tiến trình đang chờ/chạy;
 *  2. chờ tiến trình đang chạy dừng hẳn (chưa dừng → ném lỗi để pg-boss thử lại sau);
 *  3. xóa đối tượng MinIO `users/{id}/`;
 *  4. xóa bản ghi User (cascade xóa Project/file/voice/log/cấu hình/cache; `usage_records` đặt NULL
 *     để giữ thống kê tổng hợp ẩn danh);
 *  5. quét MinIO lần nữa phòng đối tượng ghi muộn.
 */
export class JobsStillRunningError extends Error {
  constructor(public readonly count: number) {
    super(`Còn ${count} tiến trình đang chạy, sẽ thử lại sau`);
    this.name = 'JobsStillRunningError';
  }
}

export async function deleteUserData(userId: string): Promise<{ existed: boolean; objectsDeleted: number }> {
  const db = getDb();
  const [user] = await db.select({ id: users.id, status: users.status }).from(users).where(eq(users.id, userId)).limit(1);

  if (user) {
    if (user.status !== 'deleting') {
      await db.update(users).set({ status: 'deleting', updatedAt: new Date() }).where(eq(users.id, userId));
    }
    // Dừng: việc đang chờ chuyển thẳng sang stopped; việc đang chạy nhận cờ hủy
    await stopAllForUser(userId);

    const [{ running } = { running: 0 }] = await db
      .select({ running: sql<number>`count(*)::int` })
      .from(voiceJobs)
      .where(and(eq(voiceJobs.ownerId, userId), eq(voiceJobs.status, 'running')));
    if (running > 0) throw new JobsStillRunningError(running);
  }

  let objectsDeleted = await deleteByPrefix(storageKeys.userPrefix(userId));
  if (user) await db.delete(users).where(eq(users.id, userId));
  objectsDeleted += await deleteByPrefix(storageKeys.userPrefix(userId));
  return { existed: !!user, objectsDeleted };
}

export async function registerDeleteUser(boss: PgBoss): Promise<void> {
  await boss.work<DeleteUserPayload>(QUEUES.deleteUser, { localConcurrency: 1 }, async (jobs) => {
    for (const job of jobs) {
      try {
        const r = await deleteUserData(job.data.userId);
        console.log(`[delete-user] ${job.data.userId}: ${r.existed ? 'đã xóa' : 'không còn'} (${r.objectsDeleted} đối tượng)`);
      } catch (e) {
        if (e instanceof JobsStillRunningError) console.log(`[delete-user] ${job.data.userId}: ${e.message}`);
        throw e; // pg-boss thử lại theo backoff
      }
    }
  });
}
