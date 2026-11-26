import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { and, eq, gt, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import { getDb, type Db } from '../../lib/db';
import { VIDEO_PIPELINE_RUNNING, videoCues, videoJobs } from '../../lib/db/schema';
import { sleep } from '../../lib/providers/adapters/shared';
import type { SonioxSttClient } from '../../lib/providers/adapters/soniox';
import { isRealtimeModel } from '../../lib/providers/adapters/soniox-types';
import { isAbort, ProviderError, toProviderError } from '../../lib/providers/errors';
import { getSettings } from '../../lib/settings';
import { deleteObject, downloadObjectToFile, getObjectBuffer, headObject } from '../../lib/storage/client';
import { storageKeys } from '../../lib/storage/keys';
import { releaseBytes, reserveBytes } from '../../lib/storage/quota';
import { getSttConfigRow, sonioxClientFor } from '../../lib/stt/config';
import { recordVideoUsage } from '../../lib/usage/record';
import { recomputeSourceExpiry } from '../../lib/video/expiry';
import { appendVideoLog, type VideoLogKey, type VideoLogLevel } from '../../lib/video/log';
import { userMayTranslate } from '../../lib/video/permission';
import { billTranslation, providerSnapshot, releaseProviderData, saveRawTranscript, type RawTranscript } from '../../lib/video/provider-data';
import { segmentCues, type DraftCue } from '../../lib/video/segmentation';
import { CUE_LIMITS, cueBytes, TARGET_LANGUAGE } from '../../lib/video/types';
import { backoffMs, DEFAULT_RETRY, type RetryPolicy } from '../pipeline/synthesize-segment';
import { QUEUES, type VideoTranslatePayload } from '../queues';
import { JobGone, JobStopped, makeVideoTempDir, RunControl, startBeat, storageFailure, VIDEO_RETRY, VideoFailure, withTransientRetry, type VideoErrorCode } from '../video/run';

/**
 * Nhận dạng và dịch (spec 006, FR-012 đến FR-017; research R5):
 *   nhận việc (giới hạn đồng thời toàn hệ thống) → gửi MP3 → tạo bản dịch một chiều kèm từ điển → chờ → lưu token thô → ghi MỘT
 *   bản ghi tính phí → gom cue và lưu → xóa dữ liệu ở nhà cung cấp → chờ duyệt.
 * Chạy lại hoặc tiếp tục sau gián đoạn dùng lại tệp token, id bản phiên âm hoặc id tệp đã có nên không tính phí lần hai.
 */
export type VideoTranslateOptions = {
  /** thử lại của từng lệnh gọi Soniox */
  providerRetry?: Partial<RetryPolicy>;
  /** thử lại của lỗi kho lưu tệp */
  retry?: Partial<RetryPolicy>;
  heartbeatMs?: number;
  pollMs?: number;
  maxPollMs?: number;
  pollTimeoutMs?: number;
  admissionPollMs?: number;
  /** thay thao tác kho (kiểm thử lỗi kho lưu tệp) */
  storage?: Partial<{ download: typeof downloadObjectToFile; saveTranscript: typeof saveRawTranscript }>;
  /** điểm dừng cho kiểm thử phục hồi: ném lỗi tại đây mô phỏng worker chết */
  onStage?: (stage: 'uploaded' | 'started' | 'transcript-saved' | 'billed' | 'cues-saved') => Promise<void>;
};

type Job = typeof videoJobs.$inferSelect;

/** Khóa tư vấn: đếm số đang dịch rồi mới nhận phải nguyên tử. */
const ADMISSION_LOCK = 727_011;
/** Việc đang chờ được coi là còn người xử lý khi vừa chạm nhịp tim. */
const WAITING_FRESH_MS = 10_000;

async function tryClaim(jobId: string): Promise<{ row: Job } | { wait: number } | null> {
  const { maxConcurrentVideoTranslations } = await getSettings();
  return getDb().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${ADMISSION_LOCK})`);
    const [cur] = await tx.select().from(videoJobs).where(eq(videoJobs.id, jobId));
    if (!cur || (cur.status !== 'queued' && cur.status !== 'interrupted') || cur.cancelRequested || !cur.audioTempKey || !cur.media) return null;
    const [running] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(videoJobs)
      .where(inArray(videoJobs.status, ['translating', 'segmenting']));
    const [older] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(videoJobs)
      .where(
        and(
          inArray(videoJobs.status, ['queued', 'interrupted']),
          isNotNull(videoJobs.audioTempKey),
          lt(videoJobs.createdAt, cur.createdAt),
          gt(videoJobs.heartbeatAt, sql`now() - (${WAITING_FRESH_MS} * interval '1 millisecond')`),
        ),
      );
    if (maxConcurrentVideoTranslations - (running?.n ?? 0) <= (older?.n ?? 0)) {
      await tx.update(videoJobs).set({ heartbeatAt: sql`now()` }).where(eq(videoJobs.id, jobId));
      return { wait: maxConcurrentVideoTranslations };
    }
    const [row] = await tx
      .update(videoJobs)
      .set({
        status: 'translating',
        stageKey: 'translating',
        attempt: sql`${videoJobs.attempt} + 1`,
        heartbeatAt: sql`now()`,
        startedAt: sql`coalesce(${videoJobs.startedAt}, now())`,
        errorCode: null,
        finishedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(videoJobs.id, jobId))
      .returning();
    return row ? { row } : null;
  });
}

async function claim(jobId: string, opts: VideoTranslateOptions): Promise<Job | null> {
  let announced = false;
  for (;;) {
    const r = await tryClaim(jobId);
    if (!r) return null;
    if ('row' in r) return r.row;
    if (!announced) {
      announced = true;
      await appendVideoLog(jobId, 'info', 'waiting', { max: r.wait });
    }
    await sleep(opts.admissionPollMs ?? 2000);
  }
}

function providerFailure(e: ProviderError): VideoFailure {
  switch (e.kind) {
    case 'auth':
      return new VideoFailure('SONIOX_AUTH');
    case 'quota':
      return new VideoFailure('SONIOX_QUOTA');
    case 'forbidden_model':
      return new VideoFailure('SONIOX_MODEL');
    case 'transient':
      return new VideoFailure('SONIOX_UNAVAILABLE');
    default:
      return new VideoFailure('SONIOX_FAILED', e.code);
  }
}

async function readRawTranscript(key: string): Promise<RawTranscript | null> {
  try {
    if (!(await headObject(key))) return null;
    return JSON.parse((await getObjectBuffer(key)).toString('utf8')) as RawTranscript;
  } catch (e) {
    throw storageFailure(e);
  }
}

const INSERT_CHUNK = 1000;

/** Thay toàn bộ cue bằng kết quả của lượt này trong một giao dịch; cue cũ giữ nguyên tới đúng lúc đó. Trả false khi lượt đã mất quyền ghi. */
async function saveCues(job: Job, cues: DraftCue[]): Promise<boolean> {
  return getDb().transaction(async (tx) => {
    const [row] = await tx
      .select({ scriptBytes: videoJobs.scriptBytes, cueRevision: videoJobs.cueRevision })
      .from(videoJobs)
      .where(and(eq(videoJobs.id, job.id), inArray(videoJobs.status, [...VIDEO_PIPELINE_RUNNING]), eq(videoJobs.attempt, job.attempt)))
      .for('update');
    if (!row) return false;
    await tx.delete(videoCues).where(eq(videoCues.jobId, job.id));
    for (let i = 0; i < cues.length; i += INSERT_CHUNK) {
      await tx.insert(videoCues).values(cues.slice(i, i + INSERT_CHUNK).map((c) => ({ ...c, jobId: job.id })));
    }
    const bytes = cues.reduce((n, c) => n + cueBytes(c), 0);
    await tx
      .update(videoJobs)
      .set({ cueCount: cues.length, cueRevision: row.cueRevision + 1, cueRun: job.translationRun, scriptBytes: bytes, lastActivityAt: new Date(), updatedAt: new Date() })
      .where(eq(videoJobs.id, job.id));
    // chữ phụ đề tính vào hạn mức 500 MB ở chế độ mềm: kết quả đã trả phí không bao giờ bị mất (FR-055)
    const delta = bytes - row.scriptBytes;
    if (delta > 0) await reserveBytes(job.ownerId, delta, { soft: true, db: tx as unknown as Db });
    else await releaseBytes(job.ownerId, -delta, tx as unknown as Db);
    return true;
  });
}

export async function runVideoTranslate(jobId: string, opts: VideoTranslateOptions = {}): Promise<void> {
  const db = getDb();
  const job = await claim(jobId, opts);
  if (!job) return;

  const control = new RunControl();
  const providerRetry: RetryPolicy = { ...DEFAULT_RETRY, ...opts.providerRetry };
  const mine = and(eq(videoJobs.id, jobId), inArray(videoJobs.status, [...VIDEO_PIPELINE_RUNNING]), eq(videoJobs.attempt, job.attempt));
  let progress = Math.max(10, Math.min(job.progressPercent, 40));
  let finished = false;
  const log = async (level: VideoLogLevel, key: VideoLogKey, params?: Record<string, string | number>) => {
    if (!control.gone) await appendVideoLog(jobId, level, key, params);
  };

  const beat = async () => {
    if (finished) return;
    const [r] = await db.update(videoJobs).set({ heartbeatAt: sql`now()`, progressPercent: progress }).where(mine).returning({ cancel: videoJobs.cancelRequested });
    if (finished) return;
    if (!r) {
      const [other] = await db.select({ id: videoJobs.id }).from(videoJobs).where(eq(videoJobs.id, jobId));
      control.interrupt(other ? 'superseded' : 'gone');
    } else if (r.cancel) control.interrupt('user');
    else if (!(await userMayTranslate(job.ownerId))) control.interrupt('revoked');
  };
  const stopBeat = startBeat(beat, opts.heartbeatMs ?? 2000);

  /** Ghi trường của việc, chỉ khi còn đúng lượt đang chạy. */
  const write = async (patch: Partial<typeof videoJobs.$inferInsert>) => {
    const r = await db.update(videoJobs).set({ ...patch, updatedAt: new Date() }).where(mine).returning({ id: videoJobs.id });
    if (r.length === 0) {
      await beat();
      control.checkpoint();
      throw new JobGone();
    }
  };

  const snapshot = () => providerSnapshot(job);

  /** Một lệnh gọi Soniox: lỗi tạm thử lại tối đa 3 lần; mỗi lần gọi lỗi ghi một bản ghi `ok = false` (FR-016). */
  const call = async <T>(fn: () => Promise<T>): Promise<T> => {
    for (let attempt = 1; ; attempt++) {
      control.checkpoint();
      try {
        return await fn();
      } catch (e) {
        control.checkpoint();
        if (isAbort(e, control.abort.signal)) throw new JobStopped();
        const pe = toProviderError(e);
        await recordFailedCall();
        // đổi sang mã lỗi của video ngay tại đây: bên ngoài không thử lại lần nữa (đã hết lượt của lệnh này)
        if (!pe.retryable || attempt >= providerRetry.maxAttempts) throw providerFailure(pe);
        const wait = backoffMs(attempt, providerRetry, pe.retryAfterMs);
        await log('warn', 'retrying', { attempt, max: providerRetry.maxAttempts - 1, sec: Math.round(wait / 100) / 10 });
        await sleep(wait, control.abort.signal).catch(() => undefined);
      }
    }
  };
  const recordFailedCall = () =>
    recordVideoUsage({ userId: job.ownerId, projectId: job.projectId, videoJobId: jobId, model: job.model, audioSeconds: 0, pricePerAudioHourUsd: null, ok: false }).catch(() => undefined);

  /** Có kết quả của lượt này (token thô) bằng mọi cách rẻ nhất: tệp đã lưu, bản phiên âm đang có, hoặc gửi mới. */
  const obtainTranscript = async (): Promise<RawTranscript> => {
    const key = storageKeys.videoTranscript(job.ownerId, jobId, job.translationRun);
    const saved = await readRawTranscript(key);
    if (saved) {
      await log('info', 'reuseResult');
      return saved;
    }
    const cfg = await getSttConfigRow();
    if (!cfg || !cfg.enabled) throw new VideoFailure('STT_NOT_CONFIGURED');
    const model = job.model ?? cfg.defaultModel;
    if (isRealtimeModel(model)) throw new VideoFailure('SONIOX_MODEL');
    job.model = model;
    const client: SonioxSttClient = sonioxClientFor(cfg, control.abort.signal).client;

    if (!job.sonioxTranscriptionId) {
      if (!job.sonioxFileId) {
        const dir = await makeVideoTempDir();
        let audio: Buffer;
        try {
          const file = path.join(dir, 'audio.mp3');
          try {
            await (opts.storage?.download ?? downloadObjectToFile)(job.audioTempKey!, file);
          } catch (e) {
            throw storageFailure(e);
          }
          audio = await readFile(file);
        } finally {
          await rm(dir, { recursive: true, force: true }).catch(() => undefined);
        }
        await log('info', 'sending');
        const { fileId } = await call(() => client.uploadAudioFile(audio, `${jobId}.mp3`));
        job.sonioxFileId = fileId;
        // lưu id ngay (kể cả khi vừa có yêu cầu dừng) để bước dọn xóa được tệp ở nhà cung cấp
        await db.update(videoJobs).set({ sonioxFileId: fileId, model }).where(eq(videoJobs.id, jobId));
        await opts.onStage?.('uploaded');
        progress = 15;
      }
      const fileId = job.sonioxFileId!;
      const { transcriptionId } = await call(() =>
        client.startTranscription(fileId, {
          model,
          // "Mọi ngôn ngữ → Việt" không gợi ý ngôn ngữ; "Việt → Anh" gợi ý tiếng Việt (FR-012, FR-013)
          languageHints: job.direction === 'vi_to_en' ? ['vi'] : undefined,
          enableLanguageIdentification: true,
          enableSpeakerDiarization: true,
          translation: { targetLanguage: TARGET_LANGUAGE[job.direction] },
          translationTerms: job.glossary.map((g) => ({ source: g.source, target: g.keep ? g.source : g.target })),
          clientReferenceId: jobId,
        }),
      );
      job.sonioxTranscriptionId = transcriptionId;
      await db.update(videoJobs).set({ sonioxTranscriptionId: transcriptionId, model }).where(eq(videoJobs.id, jobId));
      await opts.onStage?.('started');
    }
    progress = Math.max(progress, 20);
    await log('info', 'translating', { model });

    const transcriptionId = job.sonioxTranscriptionId!;
    const started = Date.now();
    let waitMs = opts.pollMs ?? 2000;
    let audioDurationMs: number | null = null;
    for (;;) {
      const t = await call(() => client.getTranscription(transcriptionId));
      if (typeof t.audio_duration_ms === 'number' && t.audio_duration_ms > 0) audioDurationMs = t.audio_duration_ms;
      if (t.status === 'completed') break;
      if (t.status === 'error' || t.status === 'failed') {
        await recordFailedCall();
        throw new VideoFailure('SONIOX_FAILED', t.error_type ?? undefined);
      }
      if (Date.now() - started > (opts.pollTimeoutMs ?? 4 * 3600_000)) throw new VideoFailure('SONIOX_UNAVAILABLE', 'poll timeout');
      progress = Math.min(36, progress + 1);
      await sleep(waitMs, control.abort.signal).catch(() => undefined);
      waitMs = Math.min(opts.maxPollMs ?? 5000, Math.round(waitMs * 1.25));
    }
    const transcript = await call(() => client.getTranscript(transcriptionId));
    const raw: RawTranscript = { run: job.translationRun, model, audioDurationMs, tokens: transcript.tokens };
    try {
      await (opts.storage?.saveTranscript ?? saveRawTranscript)(job, raw);
    } catch (e) {
      throw storageFailure(e);
    }
    await opts.onStage?.('transcript-saved');
    return raw;
  };

  const complete = async () => {
    const done = await db.transaction(async (tx) => {
      const r = await tx
        .update(videoJobs)
        .set({ status: 'review_ready', stageKey: 'reviewReady', progressPercent: 50, errorCode: null, finishedAt: new Date(), lastActivityAt: new Date(), updatedAt: new Date() })
        .where(and(mine, eq(videoJobs.cancelRequested, false)))
        .returning({ cueCount: videoJobs.cueCount });
      if (r.length) await recomputeSourceExpiry(jobId, tx as unknown as Db);
      return r[0] ?? null;
    });
    if (!done) {
      await beat();
      control.checkpoint();
      throw new JobGone();
    }
    finished = true;
    await log('info', 'reviewReady', { n: done.cueCount });
  };

  const run = async () => {
    if (job.cueRun !== job.translationRun) {
      const raw = await obtainTranscript();
      control.checkpoint();
      const cfg = await getSttConfigRow();
      const billed = await billTranslation({ ...snapshot(), model: raw.model }, raw.audioDurationMs, raw.tokens.reduce((n, t) => n + [...t.text].length, 0), cfg?.pricePerAudioHourUsd ?? null);
      if (billed) job.billedRun = job.translationRun;
      await opts.onStage?.('billed');
      if (raw.audioDurationMs != null) await log('info', 'translated', { sec: Math.round(raw.audioDurationMs / 1000) });
      progress = 40;
      await write({ status: 'segmenting', stageKey: 'segmenting', progressPercent: 40 });
      await log('info', 'segmenting');
      const cues = segmentCues(raw.tokens, { durationMs: job.media!.durationMs });
      if (cues.length === 0) throw new VideoFailure('NO_SPEECH_DETECTED');
      if (cues.length > CUE_LIMITS.maxCues) throw new VideoFailure('INTERNAL', `quá ${CUE_LIMITS.maxCues} cue`);
      if (!(await saveCues(job, cues))) {
        await beat();
        control.checkpoint();
        throw new JobGone();
      }
      job.cueRun = job.translationRun;
      progress = 48;
      await opts.onStage?.('cues-saved');
    }
    // sau khi cue đã lưu: xóa dữ liệu ở nhà cung cấp rồi tới tệp token (FR-017)
    if (!(await releaseProviderData(snapshot()))) await log('warn', 'cleanupWarn');
    await deleteObject(storageKeys.videoTranscript(job.ownerId, jobId, job.translationRun)).catch(() => undefined);
    await complete();
  };

  try {
    await beat();
    if (job.interruptions > 0) await log('info', 'resumed', { attempt: job.interruptions + 1 });
    await withTransientRetry(control, run, {
      retry: { ...VIDEO_RETRY, ...opts.retry },
      onRetry: (attempt, max, wait) => log('warn', 'retrying', { attempt, max, sec: Math.round(wait / 100) / 10 }),
    });
  } catch (e) {
    stopBeat();
    // lượt này còn giữ việc không: nếu lượt khác đã nhận lại thì không đụng vào dữ liệu của lượt đó
    await beat().catch(() => undefined);
    finished = true;
    if (control.superseded) return;
    if (e instanceof JobGone || control.gone) {
      // việc đã bị xóa: bên xóa dọn theo bản ghi đã thu thập; dữ liệu vừa gửi sau đó được dọn tại đây
      await releaseProviderData(snapshot(), { jobDeleted: true }).catch(() => undefined);
      return;
    }
    const stopped = e instanceof JobStopped || control.stopped !== null;
    const code: VideoErrorCode | null = stopped ? (control.stopped === 'revoked' ? 'PERMISSION_REVOKED' : null) : e instanceof VideoFailure ? e.code : 'INTERNAL';
    if (code === 'INTERNAL') console.error(`[video-translate] ${jobId}:`, e instanceof VideoFailure ? e.detail : e instanceof Error ? e.message : e);
    // dừng hoặc lỗi vĩnh viễn: lấy kết quả nếu đã có, rồi xóa dữ liệu ở nhà cung cấp (FR-017)
    const [cur] = await db.select().from(videoJobs).where(eq(videoJobs.id, jobId));
    if (cur && !(await releaseProviderData(providerSnapshot(cur)))) await log('warn', 'cleanupWarn');
    await db.transaction(async (tx) => {
      await tx
        .update(videoJobs)
        .set({ status: stopped ? 'stopped' : 'failed', stageKey: stopped ? 'stopped' : 'failed', errorCode: code, cancelRequested: false, finishedAt: new Date(), updatedAt: new Date() })
        .where(mine);
      await recomputeSourceExpiry(jobId, tx as unknown as Db);
    });
    if (stopped) await appendVideoLog(jobId, 'warn', 'stopped');
    else await appendVideoLog(jobId, 'error', 'failed', { reason: code! });
  } finally {
    stopBeat();
  }
}

/** Bằng mức tối đa của cài đặt `maxConcurrentVideoTranslations`; giới hạn thật do bước nhận việc. */
export const VIDEO_TRANSLATE_LOCAL_CONCURRENCY = 10;

export async function registerVideoTranslate(boss: PgBoss): Promise<void> {
  await boss.work<VideoTranslatePayload>(QUEUES.videoTranslate, { localConcurrency: VIDEO_TRANSLATE_LOCAL_CONCURRENCY }, async (jobs) => {
    for (const j of jobs) await runVideoTranslate(j.data.jobId);
  });
}
