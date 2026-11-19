import { and, eq, lt, or, isNull, sql } from 'drizzle-orm';
import { getDb } from '../lib/db';
import { voiceJobs } from '../lib/db/schema';
import { appendLog } from './job-log';
import { enqueueGenerateVoice } from './queues';

/**
 * Phục hồi sau sự cố (Nguyên tắc III): tiến trình `running` mà worker đã chết (heartbeat quá hạn) được đánh dấu
 * `interrupted` rồi xếp hàng lại để TIẾP TỤC từ các đoạn chưa xong (đoạn đã `done` được bỏ qua).
 * Tiến trình mà người dùng đã yêu cầu dừng thì chuyển `stopped` thay vì chạy lại.
 */
export const HEARTBEAT_STALE_MS = 30_000;
export const SWEEP_EVERY_MS = 15_000;

export async function sweepStaleJobs(opts: { staleMs?: number; requeue?: (jobId: string) => Promise<unknown> } = {}): Promise<{ interrupted: string[]; stopped: string[] }> {
  const db = getDb();
  const staleMs = opts.staleMs ?? HEARTBEAT_STALE_MS;
  const requeue = opts.requeue ?? enqueueGenerateVoice;

  const stale = await db
    .select({ id: voiceJobs.id, cancel: voiceJobs.cancelRequested })
    .from(voiceJobs)
    .where(
      and(
        eq(voiceJobs.status, 'running'),
        or(isNull(voiceJobs.heartbeatAt), lt(voiceJobs.heartbeatAt, sql`now() - (${staleMs} * interval '1 millisecond')`)),
      ),
    );

  const interrupted: string[] = [];
  const stopped: string[] = [];
  for (const j of stale) {
    if (j.cancel) {
      // người dùng đã yêu cầu dừng: không chạy lại
      const done = await db
        .update(voiceJobs)
        .set({ status: 'stopped', cancelRequested: false, finishedAt: new Date() })
        .where(and(eq(voiceJobs.id, j.id), eq(voiceJobs.status, 'running')))
        .returning({ id: voiceJobs.id });
      if (done.length) {
        stopped.push(j.id);
        await appendLog(j.id, 'warn', 'JOB_STOPPED', 'Tiến trình đã dừng theo yêu cầu (worker đã gián đoạn)');
      }
      continue;
    }
    // Chuyển `interrupted` chỉ khi vẫn đúng là `running` và vẫn quá hạn (tránh đè lên worker vừa sống lại)
    const marked = await db
      .update(voiceJobs)
      .set({ status: 'interrupted' })
      .where(
        and(
          eq(voiceJobs.id, j.id),
          eq(voiceJobs.status, 'running'),
          or(isNull(voiceJobs.heartbeatAt), lt(voiceJobs.heartbeatAt, sql`now() - (${staleMs} * interval '1 millisecond')`)),
        ),
      )
      .returning({ id: voiceJobs.id });
    if (marked.length === 0) continue;
    interrupted.push(j.id);
    await appendLog(j.id, 'warn', 'JOB_INTERRUPTED', 'Tiến trình bị gián đoạn (worker dừng hoặc khởi động lại). Hệ thống sẽ tự tiếp tục từ đoạn chưa xong');
    await requeue(j.id);
  }
  return { interrupted, stopped };
}

/** Quét ngay khi khởi động rồi định kỳ. Trả hàm dừng. */
export function startSweeper(): () => void {
  const run = () =>
    sweepStaleJobs()
      .then((r) => {
        if (r.interrupted.length || r.stopped.length) console.log(`[sweeper] gián đoạn: ${r.interrupted.length}, dừng: ${r.stopped.length}`);
      })
      .catch((e) => console.error('[sweeper] lỗi:', e instanceof Error ? e.message : e));
  void run();
  const timer = setInterval(run, SWEEP_EVERY_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
