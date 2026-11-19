import { and, asc, eq, gt } from 'drizzle-orm';
import { pathParam, route, type RouteContext } from '@/lib/api/errors';
import { requireUser } from '@/lib/auth/guards';
import { getDb } from '@/lib/db';
import { jobLogs, voiceJobs, voices } from '@/lib/db/schema';
import { logDto } from '@/lib/jobs/service';
import { getOwnedJob } from '@/lib/projects/access';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const POLL_MS = 1000;
const KEEPALIVE_EVERY = 15; // số vòng POLL_MS → ~15 giây
const BATCH = 200;
const TERMINAL = new Set(['completed', 'failed', 'stopped']);

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });
}

/**
 * Luồng SSE log + tiến độ (contracts/job-events.md). `id:` của sự kiện `log` là job_logs.id nên khi nối lại
 * trình duyệt gửi `Last-Event-ID` và nhận tiếp đúng phần đã bỏ lỡ (không mất, không trùng).
 */
export const GET = route(async (request: Request, ctx: RouteContext) => {
  const user = await requireUser(request);
  const job = await getOwnedJob(user.id, await pathParam(ctx, 'jobId'));
  const jobId = job.id;

  const url = new URL(request.url);
  const lastId = Number(request.headers.get('last-event-id') ?? url.searchParams.get('after') ?? 0);
  let cursor = Number.isFinite(lastId) && lastId > 0 ? lastId : 0;

  const encoder = new TextEncoder();
  const abort = new AbortController();
  request.signal.addEventListener('abort', () => abort.abort(), { once: true });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (s: string) => {
        try {
          controller.enqueue(encoder.encode(s));
        } catch {
          abort.abort();
        }
      };
      send('retry: 3000\n\n');

      const db = getDb();
      let statusKey = '';
      let progressKey = '';
      let idle = 0;

      try {
        while (!abort.signal.aborted) {
          const logs = await db
            .select()
            .from(jobLogs)
            .where(and(eq(jobLogs.jobId, jobId), gt(jobLogs.id, cursor)))
            .orderBy(asc(jobLogs.id))
            .limit(BATCH);
          for (const l of logs) {
            send(`id: ${l.id}\nevent: log\ndata: ${JSON.stringify(logDto(l))}\n\n`);
            cursor = l.id;
          }

          const [j] = await db.select().from(voiceJobs).where(eq(voiceJobs.id, jobId));
          if (!j) break; // job đã bị xóa

          let voiceId: string | null = null;
          if (j.status === 'completed') {
            const [v] = await db.select({ id: voices.id }).from(voices).where(eq(voices.jobId, jobId));
            voiceId = v?.id ?? null;
          }
          const sk = `${j.status}|${j.errorCode ?? ''}|${voiceId ?? ''}`;
          if (sk !== statusKey) {
            statusKey = sk;
            send(`event: status\ndata: ${JSON.stringify({ status: j.status, errorCode: j.errorCode, errorMessage: j.errorMessage, voiceId })}\n\n`);
          }
          const pk = `${j.status}|${j.progressDone}|${j.progressTotal}`;
          if (pk !== progressKey) {
            progressKey = pk;
            const percent = j.progressTotal > 0 ? Math.round((j.progressDone / j.progressTotal) * 100) : 0;
            send(`event: progress\ndata: ${JSON.stringify({ status: j.status, done: j.progressDone, total: j.progressTotal, percent })}\n\n`);
          }

          // Kết thúc khi job ở trạng thái cuối VÀ đã gửi hết log (vòng này không còn log mới)
          if (TERMINAL.has(j.status) && logs.length === 0) {
            send(`event: end\ndata: ${JSON.stringify({ status: j.status })}\n\n`);
            break;
          }
          if (logs.length === BATCH) continue; // còn nhiều log: lấy tiếp ngay

          idle = logs.length === 0 ? idle + 1 : 0;
          if (idle > 0 && idle % KEEPALIVE_EVERY === 0) send(': keep-alive\n\n');
          await sleep(POLL_MS, abort.signal);
        }
      } catch {
        // lỗi tạm thời của DB: đóng luồng, trình duyệt tự nối lại với Last-Event-ID
      } finally {
        try {
          controller.close();
        } catch {
          /* đã đóng */
        }
      }
    },
    cancel() {
      abort.abort();
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
      connection: 'keep-alive',
    },
  });
});
