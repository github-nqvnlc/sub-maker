import { mkdtemp, open, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { sleep } from '../../lib/providers/adapters/shared';
import type { PgBoss } from 'pg-boss';
import { encodeMp3FromFile, BYTES_PER_SAMPLE } from '../../lib/audio/ffmpeg';
import { DEFAULT_PAUSES, TimelineBuilder } from '../../lib/audio/merge';
import { mergeTimed } from '../../lib/audio/merge-timed';
import { planParts, type Part } from '../../lib/audio/placement';
import { getLimiter, requestsPerMinute } from '../../lib/providers/rate-limit';
import type { TimelineEntry } from '../../lib/db/schema/jobs';
import type { ReadingUnit } from '../../lib/parsing/reading-units';
import { loadFileCues, placeParamsOf, TIMED_MAX_CHARS, unitsForTiming } from '../../lib/jobs/timed';
import { getDb } from '../../lib/db';
import { jobSegments, projects, segments, subtitleFiles, users, voiceJobs, voices } from '../../lib/db/schema';
import { HttpError } from '../../lib/api/errors';
import { vi } from '../../lib/i18n/vi';
import { decryptSecret } from '../../lib/security/crypto';
import { buildCallContext, resolveConfigForJob } from '../../lib/providers/config-service';
import { CustomProviderUnavailable } from '../../lib/providers/custom-provider-service';
import { getProvider } from '../../lib/providers';
import { isAbort, PROVIDER_ERROR_MESSAGE, type ProviderErrorKind } from '../../lib/providers/errors';
import type { PollingOptions } from '../../lib/providers/types';
import { getSettings } from '../../lib/settings';
import { putObject } from '../../lib/storage/client';
import { storageKeys } from '../../lib/storage/keys';
import { reserveBytes } from '../../lib/storage/quota';
import { appendLog, type LogLevel } from '../job-log';
import { QUEUES, type GenerateVoicePayload } from '../queues';
import { loadCachedById } from '../pipeline/cache';
import { DEFAULT_RETRY, SegmentFailure, abortError, synthesizeSegment, type RetryPolicy } from '../pipeline/synthesize-segment';

/**
 * Tiến trình tạo voice (US1/US2). Luồng:
 *  claim (queued|interrupted → running) → chọn cấu hình AI → chạy các đoạn song song (cache/retry) →
 *  ghép PCM + tính mốc thời gian → mã hóa MP3 → lưu voice → completed.
 * Có thể TIẾP TỤC an toàn: đoạn đã `done` được bỏ qua (Nguyên tắc III). Tham số `opts` chỉ để kiểm thử.
 */

export type RunOptions = {
  retry?: Partial<RetryPolicy>;
  /** Chu kỳ ghi heartbeat và kiểm tra yêu cầu dừng (ms). Mặc định 2000. */
  heartbeatMs?: number;
  polling?: PollingOptions;
  segmentConcurrency?: number;
  /** Chu kỳ kiểm tra lại khi đang chờ tới lượt chạy (ms). Mặc định 2000. */
  admissionPollMs?: number;
  /** Chỉ để kiểm thử: ghi đè cửa sổ chia phần (ms) thay cho `timing.params.partMinutes`. */
  partWindowMs?: number;
};

/** Phụ đề có nhiều hơn số đơn vị này thì log tổng hợp theo phần (không ghi từng đơn vị) để không bùng nổ số dòng. */
const QUIET_LOG_UNITS = 200;
const PER_UNIT_LOG_CODES = new Set(['SEGMENT_REQUEST', 'SEGMENT_DONE', 'SEGMENT_CACHE_HIT']);

const FATAL_KINDS: ReadonlySet<ProviderErrorKind> = new Set(['auth', 'quota', 'forbidden_model', 'voice_invalid', 'bad_request', 'ssrf_blocked', 'transient']);

async function refreshProgress(jobId: string) {
  await getDb().execute(sql`
    update voice_jobs set progress_done = (select count(*)::int from job_segments where job_id = ${jobId} and status = 'done')
    where id = ${jobId}`);
}

/** Cập nhật trạng thái kết thúc CHỈ khi job vẫn đang `running` (tránh ghi đè trạng thái do người dùng đặt). */
async function finish(
  jobId: string,
  status: 'failed' | 'stopped' | 'completed',
  extra: { errorCode?: string | null; errorMessage?: string | null } = {},
): Promise<boolean> {
  const res = await getDb()
    .update(voiceJobs)
    .set({ status, finishedAt: new Date(), errorCode: extra.errorCode ?? null, errorMessage: extra.errorMessage ?? null })
    .where(and(eq(voiceJobs.id, jobId), eq(voiceJobs.status, 'running')))
    .returning({ id: voiceJobs.id });
  return res.length > 0;
}

/** Khóa tư vấn dùng để tuần tự hóa việc nhận job (đếm số job đang chạy rồi mới nhận phải nguyên tử). */
const ADMISSION_LOCK = 727_001;

type ClaimOutcome = { row: typeof voiceJobs.$inferSelect } | { reason: 'gone' | 'not-claimable' } | { reason: 'limit'; running: number; mine: number; max: number; maxMine: number };

async function tryClaim(jobId: string): Promise<ClaimOutcome> {
  const settings = await getSettings();
  return getDb().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${ADMISSION_LOCK})`);
    const [cur] = await tx.select().from(voiceJobs).where(eq(voiceJobs.id, jobId));
    if (!cur) return { reason: 'gone' as const };
    if ((cur.status !== 'queued' && cur.status !== 'interrupted') || cur.cancelRequested) return { reason: 'not-claimable' as const };

    const [counts] = await tx
      .select({ running: sql<number>`count(*)::int`, mine: sql<number>`(count(*) filter (where ${voiceJobs.ownerId} = ${cur.ownerId}))::int` })
      .from(voiceJobs)
      .where(eq(voiceJobs.status, 'running'));
    const running = counts?.running ?? 0;
    const mine = counts?.mine ?? 0;
    if (running >= settings.maxConcurrentJobs || mine >= settings.maxJobsPerUser) {
      return { reason: 'limit' as const, running, mine, max: settings.maxConcurrentJobs, maxMine: settings.maxJobsPerUser };
    }

    const [row] = await tx
      .update(voiceJobs)
      .set({
        status: 'running',
        startedAt: sql`coalesce(${voiceJobs.startedAt}, now())`,
        heartbeatAt: sql`now()`,
        attempt: sql`${voiceJobs.attempt} + 1`,
        errorCode: null,
        errorMessage: null,
        finishedAt: null,
      })
      .where(eq(voiceJobs.id, jobId))
      .returning();
    return { row: row! };
  });
}

/** Chờ tới lượt (giới hạn đồng thời) rồi nhận job; trả null nếu job không còn nhận được (đã xóa/dừng/đang chạy). */
async function claimJob(
  jobId: string,
  log: (level: LogLevel, code: string, message: string, meta?: Record<string, unknown>) => Promise<void>,
  opts: RunOptions,
): Promise<typeof voiceJobs.$inferSelect | null> {
  let announced = false;
  for (;;) {
    const r = await tryClaim(jobId);
    if ('row' in r) return r.row;
    if (r.reason !== 'limit') return null;
    if (!announced) {
      announced = true;
      const why = r.mine >= r.maxMine ? `tài khoản của bạn đang chạy tối đa ${r.maxMine} tiến trình cùng lúc` : `hệ thống đang chạy tối đa ${r.max} tiến trình cùng lúc`;
      await log('info', 'JOB_WAITING', `Đang chờ tới lượt: ${why}`, { running: r.running, mine: r.mine });
    }
    await sleep(opts.admissionPollMs ?? 2000);
  }
}

export async function runGenerateVoice(jobId: string, opts: RunOptions = {}): Promise<void> {
  const db = getDb();
  const secrets: string[] = [];
  const log = (level: LogLevel, code: string, message: string, meta?: Record<string, unknown>) =>
    appendLog(jobId, level, code, message, meta, secrets).then(() => undefined);

  // ---- 1) Nhận job (nguyên tử) có KIỂM SOÁT ĐỒNG THỜI: toàn hệ thống và mỗi User (FR-025) -----------
  const job = await claimJob(jobId, log, opts);
  if (!job) return; // đã xóa, đã dừng, hoặc worker khác đang chạy

  // `job` là bản ghi SAU khi tăng attempt: lần chạy đầu có attempt = 1
  const resumed = job.attempt > 1;
  await log('info', resumed ? 'JOB_RESUMED' : 'JOB_STARTED', resumed ? 'Tiếp tục tiến trình từ các đoạn chưa xong' : 'Bắt đầu tạo voice');

  try {
    // ---- 2) Chọn cấu hình AI LÚC BẮT ĐẦU (riêng nếu đủ điều kiện, ngược lại chung) -----------------
    const [owner] = await db
      .select({ id: users.id, canUseCustomAi: users.canUseCustomAi, status: users.status, role: users.role })
      .from(users)
      .where(eq(users.id, job.ownerId));
    if (!owner) return; // User đã bị xóa

    let resolved;
    try {
      // Custom Provider (spec 004, FR-022): kiểm tra lại quyền + trạng thái bật mỗi lần worker nhận job (kể cả chạy lại)
      if (job.settings.customProviderId && !job.customProviderId) throw new CustomProviderUnavailable('CUSTOM_PROVIDER_UNAVAILABLE');
      resolved = await resolveConfigForJob({ id: owner.id, canUseCustomAi: owner.canUseCustomAi, role: owner.role }, job.providerType, {
        customProviderId: job.settings.customProviderId,
      });
    } catch (e) {
      const code = e instanceof CustomProviderUnavailable ? e.reason : 'PROVIDER_NOT_CONFIGURED';
      const msg = e instanceof HttpError ? e.message : vi.errors.PROVIDER_NOT_CONFIGURED;
      await log('error', 'JOB_FAILED', msg);
      await finish(jobId, 'failed', { errorCode: code, errorMessage: msg });
      return;
    }
    const apiKey = decryptSecret(resolved.row.apiKeyEnc);
    secrets.push(apiKey);
    await db
      .update(voiceJobs)
      .set(resolved.customProviderId ? { configId: null, customProviderId: resolved.customProviderId, configScope: 'global' } : { configId: resolved.row.id, configScope: resolved.scope })
      .where(eq(voiceJobs.id, jobId));
    const provider = getProvider(job.providerType);
    await log(
      'info',
      'PROVIDER_SELECTED',
      `Dùng cấu hình ${resolved.scope === 'user' ? 'RIÊNG của bạn' : 'chung của hệ thống'} — ${provider.catalog().label}, giọng ${job.settings.voice}${job.settings.model ? `, model ${job.settings.model}` : ''}`,
      { scope: resolved.scope, type: job.providerType, model: job.settings.model ?? null, voice: job.settings.voice },
    );

    // ---- 3) Các đoạn cần đọc ----------------------------------------------------------------------
    const timing = job.settings.timing;
    let units: ReadingUnit[] | null = null;
    let cueTotal = 0;
    let segRows: Array<{ idx: number; text: string }>;
    if (timing) {
      // Chế độ khớp mốc (spec 003): đơn vị đọc dựng xác định từ cue + thiết lập timing đã chốt lúc tạo job
      const cues = await loadFileCues(job.subtitleFileId, db);
      cueTotal = cues.length;
      units = unitsForTiming(cues, timing, Math.min(provider.catalog().maxCharsPerRequest, TIMED_MAX_CHARS));
      segRows = units.map((u) => ({ idx: u.idx, text: u.text }));
    } else {
      segRows = await db
        .select({ idx: segments.idx, text: segments.text })
        .from(segments)
        .where(eq(segments.subtitleFileId, job.subtitleFileId))
        .orderBy(asc(segments.idx));
    }
    // Chia phần theo cửa sổ thời gian (chỉ để log/tiến độ và điểm đặt lại độ trễ; ghép vẫn một lượt tuần tự theo mốc tuyệt đối)
    const parts: Part[] | null = timing && units ? planParts(units, opts.partWindowMs ?? timing.params.partMinutes * 60_000) : null;
    if (segRows.length === 0) {
      await log('error', 'JOB_FAILED', 'Kịch bản không có đoạn nào để đọc');
      await finish(jobId, 'failed', { errorCode: 'EMPTY', errorMessage: 'Kịch bản không có đoạn nào để đọc.' });
      return;
    }
    await db
      .insert(jobSegments)
      .values(segRows.map((s) => ({ jobId, idx: s.idx })))
      .onConflictDoNothing();
    await db.update(voiceJobs).set({ progressTotal: segRows.length }).where(eq(voiceJobs.id, jobId));
    if (parts && parts.length > 1) {
      await log('info', 'PARTS_PLANNED', `Phụ đề dài được chia thành ${parts.length} phần để xử lý (các phần được ghép lại đúng mốc thời gian)`, { parts: parts.length });
    }
    if (timing) {
      await log('info', 'UNITS_BUILT', `Phụ đề có ${cueTotal} cue, ghép thành ${segRows.length} đoạn đọc (${timing.mergeCues ? 'ghép cue cùng câu' : 'mỗi cue một đoạn'})`, {
        cues: cueTotal,
        total: segRows.length,
        mergeCues: timing.mergeCues,
      });
    } else {
      await log('info', 'FILE_PARSED', `Kịch bản có ${segRows.length} đoạn cần đọc`, { total: segRows.length });
    }

    // Đoạn `failed` được thử lại khi tiếp tục; đoạn `done` mà audio cache đã mất thì làm lại
    await db.update(jobSegments).set({ status: 'pending', errorCode: null }).where(and(eq(jobSegments.jobId, jobId), inArray(jobSegments.status, ['failed', 'running'])));
    const states = await db.select().from(jobSegments).where(eq(jobSegments.jobId, jobId));
    const stateByIdx = new Map(states.map((s) => [s.idx, s]));
    const pending: Array<{ idx: number; text: string }> = [];
    for (const s of segRows) {
      const st = stateByIdx.get(s.idx);
      if (st?.status === 'done' && st.audioCacheId && (await loadCachedById(job.ownerId, st.audioCacheId))) continue;
      pending.push(s);
    }
    await refreshProgress(jobId);
    if (pending.length < segRows.length) {
      await log('info', 'SEGMENTS_SKIPPED', `Bỏ qua ${segRows.length - pending.length} đoạn đã có audio`, { skipped: segRows.length - pending.length });
    }

    // ---- 4) Heartbeat + theo dõi yêu cầu dừng ----------------------------------------------------
    const controller = new AbortController();
    let userStop = false;
    let jobGone = false;
    const hb = setInterval(() => {
      void (async () => {
        const [r] = await db
          .update(voiceJobs)
          .set({ heartbeatAt: sql`now()` })
          .where(eq(voiceJobs.id, jobId))
          .returning({ cancel: voiceJobs.cancelRequested, status: voiceJobs.status });
        if (!r) jobGone = true;
        if (!r || r.cancel || r.status !== 'running') {
          userStop = !!r;
          controller.abort();
        }
      })().catch(() => undefined);
    }, opts.heartbeatMs ?? 2000);
    hb.unref?.();

    // ---- 5) Chạy các đoạn song song (giới hạn đồng thời) -----------------------------------------
    const settings = await getSettings();
    const concurrency = Math.max(1, opts.segmentConcurrency ?? settings.segmentConcurrency);
    const retry: RetryPolicy = { ...DEFAULT_RETRY, ...opts.retry };
    const ctx = {
      jobId,
      ownerId: job.ownerId,
      projectId: job.projectId,
      providerType: job.providerType,
      configScope: resolved.scope,
      provider,
      callContext: (signal: AbortSignal) => buildCallContext(resolved.row, { signal, polling: opts.polling }),
      settings: { model: job.settings.model ?? null, voice: job.settings.voice, speed: job.settings.speed ?? null },
      pricePerMillionChars: resolved.row.pricePerMillionChars,
      signal: controller.signal,
      limiter: getLimiter(resolved.row.id, requestsPerMinute(job.providerType, settings)),
      retry,
      // Phụ đề rất dài: bỏ log từng đơn vị (thông tin), giữ cảnh báo/lỗi và log theo phần
      log:
        timing && segRows.length > QUIET_LOG_UNITS
          ? (level: LogLevel, code: string, message: string, meta?: Record<string, unknown>) =>
              level === 'info' && PER_UNIT_LOG_CODES.has(code) ? Promise.resolve() : log(level, code, message, meta)
          : log,
    };

    let fatal: SegmentFailure | null = null;
    const blocked: number[] = [];
    let unexpected: unknown = null;

    /** Chạy một nhóm đơn vị với giới hạn song song; dừng sớm khi bị hủy, gặp lỗi nghiêm trọng hoặc lỗi bất ngờ. */
    const runItems = async (items: Array<{ idx: number; text: string }>) => {
      let next = 0;
      await Promise.all(
        Array.from({ length: Math.min(concurrency, items.length) }, async () => {
          for (;;) {
            if (controller.signal.aborted || fatal || unexpected) return;
            const i = next++;
            const item = items[i];
            if (!item) return;
            try {
              await synthesizeSegment(ctx, item.idx, item.text);
              await refreshProgress(jobId);
            } catch (e) {
              if (isAbort(e, controller.signal)) return;
              if (e instanceof SegmentFailure) {
                if (e.kind === 'content_blocked') blocked.push(item.idx);
                else if (FATAL_KINDS.has(e.kind)) {
                  fatal ??= e;
                  controller.abort();
                }
              } else {
                unexpected ??= e;
                controller.abort();
              }
            }
          }
        }),
      );
    };

    try {
      if (parts && parts.length > 1) {
        for (const part of parts) {
          if (controller.signal.aborted || fatal || unexpected) break;
          const items = pending.filter((p) => p.idx >= part.fromUnit && p.idx <= part.toUnit);
          if (items.length === 0) continue; // phần đã xong từ lần chạy trước: bỏ qua
          await log('info', 'PART_STARTED', `Phần ${part.n}/${parts.length}: đoạn ${part.fromUnit + 1}–${part.toUnit + 1} (${items.length} đoạn cần tạo)`, {
            part: part.n,
            parts: parts.length,
            from: part.fromUnit,
            to: part.toUnit,
          });
          await runItems(items);
          if (!controller.signal.aborted && !fatal && !unexpected) await log('info', 'PART_DONE', `Phần ${part.n}/${parts.length} hoàn tất`, { part: part.n, parts: parts.length });
        }
      } else {
        await runItems(pending);
      }
    } finally {
      clearInterval(hb);
    }

    if (jobGone) return; // đã bị xóa giữa chừng
    await refreshProgress(jobId).catch(() => undefined);

    // ---- 6) Kết quả -------------------------------------------------------------------------------
    if (unexpected) throw unexpected;

    if (userStop) {
      if (await finish(jobId, 'stopped')) await log('warn', 'JOB_STOPPED', 'Tiến trình đã dừng. Các đoạn đã xong được giữ lại để tiếp tục');
      return;
    }
    if (fatal) {
      const f = fatal as SegmentFailure;
      const msg = `${PROVIDER_ERROR_MESSAGE[f.kind]}${f.kind === 'transient' ? ' Đã thử lại nhiều lần nhưng vẫn lỗi; bạn có thể tiếp tục sau.' : ''}`;
      await log('error', 'JOB_FAILED', msg, { code: f.code, idx: f.idx });
      await finish(jobId, 'failed', { errorCode: f.code, errorMessage: msg });
      return;
    }
    // Chế độ khớp mốc: đoạn bị chặn nội dung chỉ thành khe im lặng, job vẫn hoàn tất (FR-010); nếu mọi đoạn đều bị chặn thì thất bại
    const softBlocked = !!timing && blocked.length > 0 && blocked.length < segRows.length;
    if (softBlocked) {
      blocked.sort((a, b) => a - b);
      const cueList = blocked
        .slice(0, 10)
        .flatMap((i) => units![i]!.cues.map((c) => c.n))
        .slice(0, 10);
      await log('warn', 'UNITS_FAILED', `Nhà cung cấp từ chối nội dung của ${blocked.length} đoạn (cue ${cueList.join(', ')}${blocked.length > 10 ? '…' : ''}). Các đoạn này để im lặng, voice vẫn được tạo.`, {
        blocked,
        cues: cueList,
      });
    }
    if (blocked.length > 0 && !softBlocked) {
      blocked.sort((a, b) => a - b);
      const list = blocked.slice(0, 10).map((i) => i + 1).join(', ');
      const msg = `Nhà cung cấp từ chối nội dung của ${blocked.length} đoạn (đoạn ${list}${blocked.length > 10 ? '…' : ''}). Hãy sửa kịch bản rồi chạy lại.`;
      await log('error', 'JOB_FAILED', msg, { blocked });
      await finish(jobId, 'failed', { errorCode: 'CONTENT_BLOCKED', errorMessage: msg });
      return;
    }

    // ---- 7) Ghép + mã hóa + lưu voice --------------------------------------------------------------
    await mergeAndSave({
      jobId,
      ownerId: job.ownerId,
      projectId: job.projectId,
      fileId: job.subtitleFileId,
      segRows,
      voiceName: job.settings.voice,
      log,
      timed: timing && units ? { units, failed: new Set(blocked), params: placeParamsOf(timing.params) } : undefined,
    });
  } catch (e) {
    // Lỗi không lường trước: không lộ chi tiết nội bộ cho người dùng
    const detail = e instanceof Error ? `${e.name}: ${e.message}` : 'không rõ';
    console.error(`[generate-voice] job ${jobId} lỗi:`, detail);
    await log('error', 'JOB_FAILED', vi.errors.INTERNAL).catch(() => undefined);
    await finish(jobId, 'failed', { errorCode: 'INTERNAL', errorMessage: vi.errors.INTERNAL }).catch(() => undefined);
  }
}

async function mergeAndSave(a: {
  jobId: string;
  ownerId: string;
  projectId: string;
  fileId: string;
  segRows: Array<{ idx: number; text: string }>;
  voiceName: string;
  log: (level: LogLevel, code: string, message: string, meta?: Record<string, unknown>) => Promise<void>;
  /** Có ⇒ ghép theo mốc phụ đề (spec 003) thay vì nối liên tục. */
  timed?: { units: ReadingUnit[]; failed: ReadonlySet<number>; params: ReturnType<typeof placeParamsOf> };
}): Promise<void> {
  const db = getDb();
  await a.log('info', 'MERGING', `Đang ghép ${a.segRows.length} đoạn thành một voice…`, { count: a.segRows.length });

  const dir = await mkdtemp(path.join(os.tmpdir(), 'submaker-merge-'));
  const pcmPath = path.join(dir, 'all.pcm');
  const mp3Path = path.join(dir, 'voice.mp3');
  try {
    const states = await db.select().from(jobSegments).where(eq(jobSegments.jobId, a.jobId));
    const cacheIdByIdx = new Map(states.map((s) => [s.idx, s.audioCacheId]));

    let timeline: TimelineEntry[];
    let durationMs: number;
    if (a.timed) {
      // Ghép theo mốc tuyệt đối: mượn khoảng nghỉ → nén nhẹ → trượt nhẹ (contracts/timing-engine.md)
      const r = await mergeTimed({
        units: a.timed.units,
        failed: a.timed.failed,
        params: a.timed.params,
        pcmPath,
        readPcm: async (idx) => {
          const cacheId = cacheIdByIdx.get(idx);
          const cached = cacheId ? await loadCachedById(a.ownerId, cacheId) : null;
          if (!cached) throw new Error(`Thiếu audio của đoạn ${idx}`);
          return cached.pcm;
        },
      });
      timeline = r.timeline;
      durationMs = r.durationMs;
      await a.log('info', 'PLACEMENT_DONE', `Đã đặt ${a.timed.units.length - r.failedCount} đoạn vào đúng mốc phụ đề${r.overflowCount > 0 ? `; ${r.overflowCount} đoạn vượt độ trễ tối đa` : ''}`, {
        placed: a.timed.units.length - r.failedCount,
        failed: r.failedCount,
        overflow: r.overflowCount,
      });
      if (r.overflowCount > 0) {
        const over = r.timeline.filter((t) => t.overflow).slice(0, 10).map((t) => t.idx + 1);
        await a.log('warn', 'UNIT_OVERFLOW', `${r.overflowCount} đoạn đọc dài hơn khe thời gian và trễ quá mức cho phép (đoạn ${over.join(', ')}${r.overflowCount > 10 ? '…' : ''}). Hãy sửa phụ đề nếu cần khớp chính xác.`, {
          overflow: r.overflowCount,
        });
      }
    } else {
      // Ghi tuần tự ra tệp (kịch bản dài không giữ toàn bộ PCM trong bộ nhớ); mốc thời gian tính theo số mẫu
      const builder = new TimelineBuilder(DEFAULT_PAUSES);
      const fh = await open(pcmPath, 'w');
      try {
        for (const s of a.segRows) {
          const cacheId = cacheIdByIdx.get(s.idx);
          const cached = cacheId ? await loadCachedById(a.ownerId, cacheId) : null;
          if (!cached) throw new Error(`Thiếu audio của đoạn ${s.idx}`);
          const { gapSamples } = builder.add(s.idx, cached.pcm.length / BYTES_PER_SAMPLE, s.text);
          if (gapSamples > 0) await fh.write(Buffer.alloc(gapSamples * BYTES_PER_SAMPLE));
          await fh.write(cached.pcm);
        }
      } finally {
        await fh.close();
      }

      timeline = builder.timeline;
      durationMs = builder.durationMs;
    }

    await a.log('info', 'ENCODING', 'Đang mã hóa MP3…');
    await encodeMp3FromFile(pcmPath, mp3Path);
    const mp3 = await readFile(mp3Path);

    const voiceId = randomUUID();
    const key = storageKeys.voice(a.ownerId, voiceId);
    await putObject(key, mp3, 'audio/mpeg');
    await reserveBytes(a.ownerId, mp3.length, { soft: true });

    const [file] = await db.select({ name: subtitleFiles.originalName }).from(subtitleFiles).where(eq(subtitleFiles.id, a.fileId));
    const title = `${file?.name ?? 'Voice'} · ${a.voiceName}`.slice(0, 200);

    try {
      await db.transaction(async (tx) => {
        const done = await tx
          .update(voiceJobs)
          .set({ status: 'completed', finishedAt: new Date(), errorCode: null, errorMessage: null, progressDone: a.segRows.length })
          .where(and(eq(voiceJobs.id, a.jobId), eq(voiceJobs.status, 'running')))
          .returning({ id: voiceJobs.id });
        if (done.length === 0) throw new Error('JOB_NOT_RUNNING'); // người dùng dừng/xóa ngay lúc cuối
        await tx.insert(voices).values({
          id: voiceId,
          projectId: a.projectId,
          ownerId: a.ownerId,
          jobId: a.jobId,
          subtitleFileId: a.fileId,
          title,
          storageKey: key,
          format: 'mp3',
          durationMs,
          sizeBytes: mp3.length,
          timeline,
        });
        await tx
          .update(projects)
          .set({ voiceCount: sql`${projects.voiceCount} + 1`, updatedAt: sql`now()` })
          .where(eq(projects.id, a.projectId));
      });
    } catch (e) {
      // hoàn tác đối tượng đã tải lên và số liệu dung lượng
      const { deleteObject } = await import('../../lib/storage/client');
      const { releaseBytes } = await import('../../lib/storage/quota');
      await deleteObject(key).catch(() => undefined);
      await releaseBytes(a.ownerId, mp3.length).catch(() => undefined);
      if (e instanceof Error && e.message === 'JOB_NOT_RUNNING') return;
      throw e;
    }

    await a.log('info', 'VOICE_SAVED', `Đã lưu voice (${(durationMs / 1000).toFixed(1)} giây, ${(mp3.length / 1024).toFixed(0)} KB)`, {
      voiceId,
      durationMs,
    });
    await a.log('info', 'JOB_COMPLETED', 'Hoàn tất tạo voice');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function registerGenerateVoice(boss: PgBoss): Promise<void> {
  // Giới hạn đồng thời thật sự (toàn hệ thống / mỗi User) do bước admission ở US2 đảm nhiệm;
  // ở đây cho phép nhiều handler song song và để DB quyết định.
  await boss.work<GenerateVoicePayload>(QUEUES.generateVoice, { localConcurrency: 8 }, async (jobs) => {
    for (const j of jobs) await runGenerateVoice(j.data.jobId);
  });
}

export { abortError };
