import { and, eq, inArray, sql } from 'drizzle-orm';
import { getDb } from '../db';
import { voiceJobs } from '../db/schema';
import { stopAllOverlayForUser } from '../overlay/control';
import { appendLogSafe } from './log';

/**
 * Điều khiển tiến trình: dừng (FR-021). Cơ chế: tiến trình đang chạy nhận cờ `cancel_requested` và worker dừng
 * giữa các đoạn (giữ phần đã xong); tiến trình đang chờ/gián đoạn chuyển thẳng sang `stopped`.
 * Dùng chung cho thao tác của người dùng, khóa User và xóa User.
 */

export type StopResult = { stopped: string[]; stopRequested: string[]; untouched: string[] };

/** Dừng các tiến trình thuộc `ownerId` (lọc theo chủ sở hữu để không thao tác lên tiến trình của người khác). */
export async function requestStop(ownerId: string, jobIds: string[]): Promise<StopResult> {
  const result: StopResult = { stopped: [], stopRequested: [], untouched: [] };
  if (jobIds.length === 0) return result;
  const db = getDb();

  // 1) Đang chờ hoặc bị gián đoạn: dừng ngay
  const stopped = await db
    .update(voiceJobs)
    .set({ status: 'stopped', cancelRequested: false, finishedAt: new Date() })
    .where(and(eq(voiceJobs.ownerId, ownerId), inArray(voiceJobs.id, jobIds), inArray(voiceJobs.status, ['queued', 'interrupted'])))
    .returning({ id: voiceJobs.id });
  for (const j of stopped) {
    result.stopped.push(j.id);
    await appendLogSafe(j.id, 'warn', 'JOB_STOPPED', 'Tiến trình đã dừng trước khi bắt đầu chạy');
  }

  // 2) Đang chạy: đặt cờ, worker sẽ dừng giữa các đoạn
  const requested = await db
    .update(voiceJobs)
    .set({ cancelRequested: true })
    .where(and(eq(voiceJobs.ownerId, ownerId), inArray(voiceJobs.id, jobIds), eq(voiceJobs.status, 'running')))
    .returning({ id: voiceJobs.id });
  for (const j of requested) {
    result.stopRequested.push(j.id);
    await appendLogSafe(j.id, 'warn', 'JOB_STOP_REQUESTED', 'Đã nhận yêu cầu dừng, tiến trình sẽ dừng sau đoạn đang xử lý');
  }

  const handled = new Set([...result.stopped, ...result.stopRequested]);
  result.untouched = jobIds.filter((id) => !handled.has(id));
  return result;
}

/** Dừng mọi tiến trình đang chờ/chạy/gián đoạn của một User (khóa hoặc xóa User). */
export async function stopAllForUser(ownerId: string): Promise<StopResult> {
  const rows = await getDb()
    .select({ id: voiceJobs.id })
    .from(voiceJobs)
    .where(and(eq(voiceJobs.ownerId, ownerId), inArray(voiceJobs.status, ['queued', 'running', 'interrupted'])));
  // Tiến trình xuất video overlay của User cũng dừng (spec 005); không gộp vào kết quả vì khác loại tiến trình
  await stopAllOverlayForUser(ownerId);
  return requestStop(ownerId, rows.map((r) => r.id));
}

/** Số tiến trình đang chạy của User (dùng cho kiểm tra chờ xóa). */
export async function runningCountForUser(ownerId: string): Promise<number> {
  const [r] = await getDb()
    .select({ n: sql<number>`count(*)::int` })
    .from(voiceJobs)
    .where(and(eq(voiceJobs.ownerId, ownerId), eq(voiceJobs.status, 'running')));
  return r?.n ?? 0;
}
