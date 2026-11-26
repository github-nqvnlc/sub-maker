import { and, eq, inArray, lt, notInArray, or, isNull, sql } from 'drizzle-orm';
import { getDb } from '../lib/db';
import {
  overlayAudios,
  overlayJobs,
  STT_RUNNING_STATUSES,
  sttJobLogs,
  sttJobs,
  VIDEO_PIPELINE_ACTIVE,
  VIDEO_PIPELINE_RUNNING,
  videoJobs,
  videoUploads,
  voiceJobs,
} from '../lib/db/schema';
import { deleteOverlayObject } from '../lib/overlay/control';
import { appendOverlayLog } from '../lib/overlay/log';
import { recomputeSourceExpiry } from '../lib/video/expiry';
import { appendVideoLog } from '../lib/video/log';
import { providerSnapshot, releaseProviderData } from '../lib/video/provider-data';
import { expireUpload } from '../lib/video/uploads';
import { appendLog } from './job-log';
import { enqueueGenerateVoice, enqueuePrepareOverlayAudio, enqueueRenderOverlay, enqueueTranscribeMedia, enqueueVideoPrepare, enqueueVideoPreview, enqueueVideoTranslate } from './queues';
import { MAX_VIDEO_INTERRUPTIONS } from './video/run';

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

/**
 * STT job (spec 004, FR-019): job đang chạy mà heartbeat quá hạn (worker chết/khởi động lại) → `interrupted` rồi xếp hàng lại.
 * Worker tiếp tục từ `soniox_transcription_id` / `soniox_file_id` đã lưu nên không upload lại.
 */
export async function sweepStaleSttJobs(opts: { staleMs?: number; requeue?: (jobId: string) => Promise<unknown> } = {}): Promise<{ interrupted: string[] }> {
  const db = getDb();
  const staleMs = opts.staleMs ?? HEARTBEAT_STALE_MS;
  const requeue = opts.requeue ?? enqueueTranscribeMedia;
  const stale = sql`(${sttJobs.heartbeatAt} is null or ${sttJobs.heartbeatAt} < now() - (${staleMs} * interval '1 millisecond'))`;
  // Chỉ chuyển khi VẪN đang chạy và vẫn quá hạn (tránh đè lên worker vừa sống lại)
  const marked = await db
    .update(sttJobs)
    .set({ status: 'interrupted', stageMessage: 'interrupted', updatedAt: new Date() })
    .where(and(inArray(sttJobs.status, [...STT_RUNNING_STATUSES]), stale))
    .returning({ id: sttJobs.id });
  for (const j of marked) {
    await db.insert(sttJobLogs).values({ sttJobId: j.id, level: 'warn', messageKey: 'interrupted' }).catch(() => undefined);
    await requeue(j.id);
  }
  return { interrupted: marked.map((j) => j.id) };
}

/** Video overlay (spec 005, FR-037): gián đoạn quá số lần này trong một lượt chạy thì báo lỗi thay vì chạy mãi. */
export const MAX_OVERLAY_INTERRUPTIONS = 3;

/**
 * Tiến trình xuất video đang chạy mà nhịp tim quá hạn: đã yêu cầu dừng → `stopped`; còn lượt → `interrupted` rồi xếp lại (xuất lại từ
 * đầu); gián đoạn quá 3 lần → `failed`. Video chưa hoàn tất bị xóa khỏi kho.
 */
export async function sweepStaleOverlayJobs(
  opts: { staleMs?: number; requeue?: (jobId: string) => Promise<unknown> } = {},
): Promise<{ interrupted: string[]; stopped: string[]; failed: string[] }> {
  const db = getDb();
  const staleMs = opts.staleMs ?? HEARTBEAT_STALE_MS;
  const requeue = opts.requeue ?? enqueueRenderOverlay;
  const stale = and(
    eq(overlayJobs.status, 'running'),
    sql`(${overlayJobs.heartbeatAt} is null or ${overlayJobs.heartbeatAt} < now() - (${staleMs} * interval '1 millisecond'))`,
  );
  const back = { id: overlayJobs.id, ownerId: overlayJobs.ownerId, format: overlayJobs.format };
  const stopped = await db
    .update(overlayJobs)
    .set({ status: 'stopped', cancelRequested: false, finishedAt: new Date() })
    .where(and(stale, eq(overlayJobs.cancelRequested, true)))
    .returning(back);
  const failed = await db
    .update(overlayJobs)
    .set({ status: 'failed', errorCode: 'RENDER_CRASHED', interruptions: sql`${overlayJobs.interruptions} + 1`, finishedAt: new Date() })
    .where(and(stale, sql`${overlayJobs.interruptions} >= ${MAX_OVERLAY_INTERRUPTIONS}`))
    .returning(back);
  const interrupted = await db
    .update(overlayJobs)
    .set({ status: 'interrupted', interruptions: sql`${overlayJobs.interruptions} + 1` })
    .where(stale)
    .returning(back);
  for (const j of stopped) {
    await deleteOverlayObject(j);
    await appendOverlayLog(j.id, 'warn', 'stopped');
  }
  for (const j of failed) {
    await deleteOverlayObject(j);
    await appendOverlayLog(j.id, 'error', 'failed', { reason: 'RENDER_CRASHED' });
  }
  for (const j of interrupted) {
    await appendOverlayLog(j.id, 'warn', 'interrupted');
    await requeue(j.id);
  }
  const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id);
  return { interrupted: ids(interrupted), stopped: ids(stopped), failed: ids(failed) };
}

/** Việc video đang chờ mà không worker nào chạm tới quá mức này thì coi là mất khỏi hàng đợi. */
export const VIDEO_QUEUE_LOST_MS = 5 * 60_000;

export type VideoSweepOptions = {
  staleMs?: number;
  lostMs?: number;
  prepare?: (jobId: string) => Promise<unknown>;
  translate?: (jobId: string) => Promise<unknown>;
  preview?: (jobId: string) => Promise<unknown>;
};

/**
 * Dịch video (spec 006, FR-050): pipeline mất nhịp tim → đã yêu cầu dừng thì `stopped`, còn lượt thì `interrupted` rồi xếp lại (tiếp
 * tục từ phần đã xong), quá 3 lần thì `failed`; việc chờ bị mất khỏi hàng đợi được xếp lại; kiểm video tải lại và bản xem trước mất
 * nhịp tim được xếp lại (bản xem trước quá 3 lần thì `failed`); phiên tải quá hạn được dọn.
 */
export async function sweepStaleVideoJobs(opts: VideoSweepOptions = {}): Promise<{ interrupted: string[]; stopped: string[]; failed: string[]; requeued: string[] }> {
  const db = getDb();
  const staleMs = opts.staleMs ?? HEARTBEAT_STALE_MS;
  const lostMs = opts.lostMs ?? VIDEO_QUEUE_LOST_MS;
  const prepare = opts.prepare ?? enqueueVideoPrepare;
  const translate = opts.translate ?? enqueueVideoTranslate;
  const preview = opts.preview ?? enqueueVideoPreview;
  const older = (column: unknown, ms: number) => sql`(${column} is null or ${column} < now() - (${ms} * interval '1 millisecond'))`;
  const running = and(inArray(videoJobs.status, [...VIDEO_PIPELINE_RUNNING]), older(videoJobs.heartbeatAt, staleMs));
  const back = { id: videoJobs.id, audioTempKey: videoJobs.audioTempKey, media: videoJobs.media, ownerId: videoJobs.ownerId };
  const enqueue = (j: { id: string; audioTempKey: string | null; media: unknown }) => (j.audioTempKey && j.media ? translate(j.id) : prepare(j.id));

  const stopped = await db
    .update(videoJobs)
    .set({ status: 'stopped', stageKey: 'stopped', cancelRequested: false, heartbeatAt: null, finishedAt: new Date(), updatedAt: new Date() })
    .where(and(running, eq(videoJobs.cancelRequested, true)))
    .returning(back);
  const failed = await db
    .update(videoJobs)
    .set({ status: 'failed', stageKey: 'failed', errorCode: 'INTERRUPTED', interruptions: sql`${videoJobs.interruptions} + 1`, heartbeatAt: null, finishedAt: new Date(), updatedAt: new Date() })
    .where(and(running, sql`${videoJobs.interruptions} >= ${MAX_VIDEO_INTERRUPTIONS}`))
    .returning(back);
  const interrupted = await db
    .update(videoJobs)
    .set({ status: 'interrupted', stageKey: 'interrupted', interruptions: sql`${videoJobs.interruptions} + 1`, heartbeatAt: null, updatedAt: new Date() })
    .where(running)
    .returning(back);
  for (const j of [...stopped, ...failed]) {
    await recomputeSourceExpiry(j.id, db);
    const [row] = await db.select().from(videoJobs).where(eq(videoJobs.id, j.id));
    // dừng hoặc lỗi vĩnh viễn: lấy kết quả đã có rồi xóa dữ liệu ở nhà cung cấp (FR-017)
    if (row) await releaseProviderData(providerSnapshot(row)).catch(() => false);
  }
  for (const j of stopped) await appendVideoLog(j.id, 'warn', 'stopped');
  for (const j of failed) await appendVideoLog(j.id, 'error', 'failed', { reason: 'INTERRUPTED' });
  for (const j of interrupted) {
    await appendVideoLog(j.id, 'warn', 'interrupted');
    await enqueue(j);
  }

  // chờ quá lâu mà không ai chạm tới (mất việc trong hàng đợi, web chết trước khi xếp). Bước nhận việc là nguyên tử nên xếp trùng vô hại.
  const lost = await db
    .update(videoJobs)
    .set({ updatedAt: new Date() })
    .where(
      and(
        inArray(videoJobs.status, ['queued', 'interrupted']),
        older(videoJobs.heartbeatAt, lostMs),
        sql`${videoJobs.updatedAt} < now() - (${lostMs} * interval '1 millisecond')`,
      ),
    )
    .returning(back);
  for (const j of lost) await enqueue(j);

  const checks = await db
    .update(videoJobs)
    .set({ updatedAt: new Date() })
    .where(
      and(
        eq(videoJobs.sourceState, 'checking'),
        notInArray(videoJobs.status, [...VIDEO_PIPELINE_ACTIVE]),
        older(videoJobs.heartbeatAt, staleMs),
        sql`${videoJobs.updatedAt} < now() - (${staleMs} * interval '1 millisecond')`,
      ),
    )
    .returning({ id: videoJobs.id });
  for (const j of checks) await prepare(j.id);

  // bản xem trước mất nhịp tim (hoặc chưa ai nhận)
  const previewStale = and(
    eq(videoJobs.previewState, 'pending'),
    sql`case when ${videoJobs.previewHeartbeatAt} is null then ${videoJobs.updatedAt} < now() - (${lostMs} * interval '1 millisecond')
      else ${videoJobs.previewHeartbeatAt} < now() - (${staleMs} * interval '1 millisecond') end`,
  );
  const dead = await db
    .update(videoJobs)
    .set({ previewState: 'failed', previewHeartbeatAt: null })
    .where(and(previewStale, sql`${videoJobs.previewAttempt} > ${MAX_VIDEO_INTERRUPTIONS}`))
    .returning({ id: videoJobs.id });
  for (const j of dead) await appendVideoLog(j.id, 'warn', 'previewFailed');
  const again = await db
    .update(videoJobs)
    .set({ previewHeartbeatAt: null, updatedAt: new Date() })
    .where(previewStale)
    .returning({ id: videoJobs.id });
  for (const j of again) await preview(j.id);

  const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id);
  return { interrupted: ids(interrupted), stopped: ids(stopped), failed: ids(failed), requeued: [...ids(lost), ...ids(checks), ...ids(again)] };
}

/** Phiên tải video quá 48 giờ không hoạt động: dọn phiên (và việc chưa có kịch bản). */
export async function sweepExpiredVideoUploads(): Promise<{ expired: string[] }> {
  const rows = await getDb()
    .select()
    .from(videoUploads)
    .where(and(inArray(videoUploads.state, ['active', 'completing']), lt(videoUploads.expiresAt, new Date())));
  const expired: string[] = [];
  for (const u of rows) {
    await expireUpload(u)
      .then(() => expired.push(u.id))
      .catch((e) => console.error('[sweeper] không dọn được phiên tải:', e instanceof Error ? e.message : e));
  }
  return { expired };
}

/** Tệp âm thanh chờ quá lâu mà chưa worker nào nhận (mất việc trong hàng đợi, web chết giữa lúc nhận tệp). */
const AUDIO_LOST_MS = 15 * 60_000;

/**
 * Tệp âm thanh overlay đang xử lý mà worker đã chết hoặc bị mất khỏi hàng đợi: xếp lại. Bước nhận việc đếm số lần gián đoạn và
 * báo lỗi khi quá giới hạn, nên xếp lại trùng không gây hại.
 */
export async function sweepStaleOverlayAudios(
  opts: { staleMs?: number; lostMs?: number; requeue?: (audioId: string) => Promise<unknown> } = {},
): Promise<{ requeued: string[] }> {
  const requeue = opts.requeue ?? enqueuePrepareOverlayAudio;
  const rows = await getDb()
    .select({ id: overlayAudios.id })
    .from(overlayAudios)
    .where(
      and(
        eq(overlayAudios.status, 'processing'),
        sql`case when ${overlayAudios.heartbeatAt} is null then ${overlayAudios.createdAt} < now() - (${opts.lostMs ?? AUDIO_LOST_MS} * interval '1 millisecond')
          else ${overlayAudios.heartbeatAt} < now() - (${opts.staleMs ?? HEARTBEAT_STALE_MS} * interval '1 millisecond') end`,
      ),
    );
  for (const r of rows) await requeue(r.id);
  return { requeued: rows.map((r) => r.id) };
}

/** Quét ngay khi khởi động rồi định kỳ. Trả hàm dừng. */
export function startSweeper(): () => void {
  const run = () =>
    Promise.all([sweepStaleJobs(), sweepStaleSttJobs(), sweepStaleOverlayJobs(), sweepStaleOverlayAudios(), sweepStaleVideoJobs(), sweepExpiredVideoUploads()])
      .then(([r, s, o, a, v, u]) => {
        if (r.interrupted.length || r.stopped.length) console.log(`[sweeper] gián đoạn: ${r.interrupted.length}, dừng: ${r.stopped.length}`);
        if (s.interrupted.length) console.log(`[sweeper] STT gián đoạn: ${s.interrupted.length}`);
        if (o.interrupted.length || o.stopped.length || o.failed.length) {
          console.log(`[sweeper] overlay gián đoạn: ${o.interrupted.length}, dừng: ${o.stopped.length}, lỗi: ${o.failed.length}`);
        }
        if (a.requeued.length) console.log(`[sweeper] âm thanh overlay xếp lại: ${a.requeued.length}`);
        if (v.interrupted.length || v.stopped.length || v.failed.length || v.requeued.length) {
          console.log(`[sweeper] video gián đoạn: ${v.interrupted.length}, dừng: ${v.stopped.length}, lỗi: ${v.failed.length}, xếp lại: ${v.requeued.length}`);
        }
        if (u.expired.length) console.log(`[sweeper] phiên tải video quá hạn: ${u.expired.length}`);
      })
      .catch((e) => console.error('[sweeper] lỗi:', e instanceof Error ? e.message : e));
  void run();
  const timer = setInterval(run, SWEEP_EVERY_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
