import { pathParam, route, type RouteContext } from '@/lib/api/errors';
import { requireUser } from '@/lib/auth/guards';
import { getOwnedVideoJob, isBusyJob, toDto, videoLogDto, videoLogsAfter } from '@/lib/video/service';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const POLL_MS = 1000;
const KEEPALIVE_EVERY = 15; // số vòng POLL_MS → ~15 giây
const BATCH = 200;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * Luồng SSE của một việc dịch (spec 006, FR-048): `log`, `status`, `progress`, `end`. `id:` của sự kiện `log` là id nhật ký nên khi
 * nối lại (Last-Event-ID) không mất, không trùng. Khuôn mẫu theo `api/jobs/[jobId]/events`.
 */
export const GET = route(async (request: Request, ctx: RouteContext) => {
  const user = await requireUser(request);
  const jobId = (await getOwnedVideoJob(user.id, await pathParam(ctx, 'jobId'))).id;

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
      let statusKey = '';
      let progressKey = '';
      let idle = 0;
      try {
        while (!abort.signal.aborted) {
          const logs = await videoLogsAfter(jobId, cursor, BATCH);
          for (const l of logs) {
            send(`id: ${l.id}\nevent: log\ndata: ${JSON.stringify(videoLogDto(l))}\n\n`);
            cursor = l.id;
          }
          const row = await getOwnedVideoJob(user.id, jobId).catch(() => null);
          if (!row) break; // việc đã bị xóa
          const dto = await toDto(row);
          const sk = [dto.status, dto.displayStatus, dto.errorCode, dto.sourceState, dto.previewState, dto.cueRevision, dto.sourceExpiresAt].join('|');
          if (sk !== statusKey) {
            statusKey = sk;
            send(`event: status\ndata: ${JSON.stringify(dto)}\n\n`);
          }
          const pk = `${dto.displayStatus}|${dto.progressPercent}|${dto.upload?.receivedBytes ?? ''}`;
          if (pk !== progressKey) {
            progressKey = pk;
            send(`event: progress\ndata: ${JSON.stringify({ displayStatus: dto.displayStatus, percent: dto.progressPercent })}\n\n`);
          }
          // Kết thúc khi không còn gì đang chạy VÀ đã gửi hết nhật ký
          if (!isBusyJob(dto) && dto.displayStatus !== 'waiting_media' && logs.length === 0) {
            send(`event: end\ndata: ${JSON.stringify({ displayStatus: dto.displayStatus })}\n\n`);
            break;
          }
          if (logs.length === BATCH) continue;
          idle = logs.length === 0 ? idle + 1 : 0;
          if (idle > 0 && idle % KEEPALIVE_EVERY === 0) send(': keep-alive\n\n');
          await sleep(POLL_MS, abort.signal);
        }
      } catch {
        // lỗi tạm thời của CSDL: đóng luồng, trình duyệt tự nối lại với Last-Event-ID
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
