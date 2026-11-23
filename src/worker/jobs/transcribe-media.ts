import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import { getDb } from '../../lib/db';
import { STT_RUNNING_STATUSES, sttJobLogs, sttJobs, users, type SttJobStatus } from '../../lib/db/schema';
import { HttpError } from '../../lib/api/errors';
import { extractAudioToMp3File, MediaUnreadableError, NoAudioStreamError, probeMedia } from '../../lib/audio/ffmpeg';
import { fmt } from '../../lib/i18n/fmt';
import { getDict } from '../../lib/i18n';
import { vi } from '../../lib/i18n/vi';
import { chunkTokensToMd, chunkTokensToSrt, chunkTokensToTxt } from '../../lib/parsing/stt-chunker';
import { uploadScript } from '../../lib/projects/files';
import { ProviderError, isAbort, toProviderError } from '../../lib/providers/errors';
import { sleep } from '../../lib/providers/adapters/shared';
import type { SonioxSttClient } from '../../lib/providers/adapters/soniox';
import { isRealtimeModel, type SonioxToken } from '../../lib/providers/adapters/soniox-types';
import { redactDeep } from '../../lib/security/redact';
import { downloadObjectToFile } from '../../lib/storage/client';
import { getSttConfigRow, sonioxClientFor } from '../../lib/stt/config';
import { deleteSonioxData, deleteTempMedia } from '../../lib/stt/cleanup';
import { MAX_MEDIA_DURATION_MS } from '../../lib/stt/service';
import { recordSttUsage } from '../../lib/usage/record';
import { DEFAULT_RETRY, backoffMs, type RetryPolicy } from '../pipeline/synthesize-segment';
import { QUEUES, type TranscribeMediaPayload } from '../queues';

/**
 * Tiến trình STT (spec 004, US1/US3). Luồng:
 *   claim (queued|interrupted → extracting) → ffprobe (≤ 60 phút, có âm thanh) → tách MP3 mono 16 kHz → upload Soniox
 *   → tạo transcription → poll → lấy transcript → tạo .srt/.txt/.md → uploadScript → dọn dữ liệu tạm → completed.
 * Tiếp tục an toàn sau gián đoạn (FR-019): đã có `sonioxTranscriptionId` → chỉ poll; đã có `sonioxFileId` → tạo transcription.
 * Lỗi tạm thời của Soniox (mạng, 429, 5xx) thử lại tối đa 3 lần với backoff; lỗi vĩnh viễn không thử lại.
 * Khóa API không bao giờ ra log/nhật ký (Nguyên tắc II).
 */

export type SttRunOptions = {
  retry?: Partial<RetryPolicy>;
  /** Chu kỳ poll trạng thái Soniox (ms). Mặc định 2000, tăng dần tới `maxPollMs`. */
  pollMs?: number;
  maxPollMs?: number;
  /** Tổng thời gian chờ Soniox phiên âm (ms). Mặc định 2 giờ. */
  pollTimeoutMs?: number;
  heartbeatMs?: number;
};

export type SttErrorCode = keyof typeof vi.stt.errors;

class SttFailure extends Error {
  constructor(
    public readonly code: SttErrorCode,
    public readonly detail?: string,
  ) {
    super(code);
    this.name = 'SttFailure';
  }
}

/** Job đã bị xóa (xóa Project/User) trong lúc chạy. */
class JobGone extends Error {
  constructor() {
    super('JOB_GONE');
  }
}

function providerFailure(e: ProviderError): SttFailure {
  switch (e.kind) {
    case 'auth':
      return new SttFailure('SONIOX_AUTH');
    case 'quota':
      return new SttFailure('SONIOX_QUOTA');
    case 'forbidden_model':
      return new SttFailure('SONIOX_MODEL');
    case 'transient':
      return new SttFailure('SONIOX_UNAVAILABLE');
    default:
      return new SttFailure('SONIOX_FAILED', e.code);
  }
}

type Job = typeof sttJobs.$inferSelect;

/** Nhận job nguyên tử: chỉ `queued` hoặc `interrupted`. */
async function claim(jobId: string): Promise<Job | null> {
  const [row] = await getDb()
    .update(sttJobs)
    .set({
      status: 'extracting',
      attempt: sql`${sttJobs.attempt} + 1`,
      heartbeatAt: sql`now()`,
      startedAt: sql`coalesce(${sttJobs.startedAt}, now())`,
      errorCode: null,
      errorMessage: null,
      finishedAt: null,
      updatedAt: new Date(),
    })
    .where(and(eq(sttJobs.id, jobId), inArray(sttJobs.status, ['queued', 'interrupted'])))
    .returning();
  return row ?? null;
}

export async function runTranscribeMedia(jobId: string, opts: SttRunOptions = {}): Promise<void> {
  const db = getDb();
  const job = await claim(jobId);
  if (!job) return; // đã xóa, đang chạy ở worker khác, hoặc đã kết thúc

  const retry: RetryPolicy = { ...DEFAULT_RETRY, ...opts.retry };
  const controller = new AbortController();
  let gone = false;
  // Id trên Soniox đã biết (để dọn khi kết thúc/bị xóa)
  const ids = { fileId: job.sonioxFileId, transcriptionId: job.sonioxTranscriptionId };
  let tempKey = job.tempStorageKey;

  const log = async (level: 'info' | 'warn' | 'error', messageKey: keyof typeof vi.stt.log, params?: Record<string, string | number>) => {
    if (gone) return;
    await db
      .insert(sttJobLogs)
      .values({ sttJobId: jobId, level, messageKey, params: params ? (redactDeep(params) as Record<string, string | number>) : null })
      .catch(() => undefined); // job vừa bị xóa (FK) → bỏ qua
  };

  /** Cập nhật trạng thái; job không còn → JobGone. */
  const stage = async (status: SttJobStatus, progressPercent: number, patch: Partial<typeof sttJobs.$inferInsert> = {}) => {
    const r = await db
      .update(sttJobs)
      .set({ status, progressPercent, stageMessage: status, heartbeatAt: sql`now()`, updatedAt: new Date(), ...patch })
      .where(eq(sttJobs.id, jobId))
      .returning({ id: sttJobs.id });
    if (r.length === 0) {
      gone = true;
      throw new JobGone();
    }
  };

  const hb = setInterval(() => {
    void db
      .update(sttJobs)
      .set({ heartbeatAt: sql`now()` })
      .where(eq(sttJobs.id, jobId))
      .returning({ id: sttJobs.id })
      .then((r) => {
        if (r.length === 0) {
          gone = true;
          controller.abort();
        }
      })
      .catch(() => undefined);
  }, opts.heartbeatMs ?? 2000);
  hb.unref?.();

  /** Gọi Soniox có thử lại cho lỗi tạm thời; lỗi cuối cùng được ghi usage `ok = false`. */
  const withRetry = async <T>(fn: () => Promise<T>): Promise<T> => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await fn();
      } catch (e) {
        if (gone || isAbort(e, controller.signal)) throw new JobGone();
        const pe = toProviderError(e);
        await recordSttUsage({ userId: job.ownerId, projectId: job.projectId, sttJobId: jobId, model: job.model, audioSeconds: 0, pricePerAudioHourUsd: null, ok: false }).catch(() => undefined);
        if (!pe.retryable || attempt >= retry.maxAttempts) throw pe;
        const wait = backoffMs(attempt, retry, pe.retryAfterMs);
        await log('warn', 'retrying', { attempt, max: retry.maxAttempts - 1, sec: Math.round(wait / 100) / 10 });
        await sleep(wait, controller.signal).catch(() => {
          throw new JobGone();
        });
      }
    }
  };

  const dir = await mkdtemp(path.join(os.tmpdir(), 'submaker-stt-'));
  let client: SonioxSttClient | null = null;
  try {
    const [owner] = await db.select({ locale: users.locale }).from(users).where(eq(users.id, job.ownerId));
    if (!owner) throw new JobGone();
    const dict = getDict(owner.locale);

    await log('info', job.attempt > 1 ? 'resumed' : 'started', { file: job.originalFileName });

    const cfg = await getSttConfigRow();
    if (!cfg || !cfg.enabled) throw new SttFailure('STT_NOT_CONFIGURED');
    const model = job.model ?? cfg.defaultModel;
    if (isRealtimeModel(model)) throw new SttFailure('SONIOX_MODEL');
    client = sonioxClientFor(cfg, controller.signal).client;
    const c = client;

    // ---- 1) Tách âm thanh + upload (bỏ qua khi tiếp tục và Soniox đã có file) ----------------------
    if (!ids.fileId) {
      if (!tempKey) throw new SttFailure('MEDIA_UNREADABLE', 'missing temp file');
      await stage('extracting', 5);
      const ext = path.extname(tempKey) || '.bin';
      const src = path.join(dir, `source${ext}`);
      const out = path.join(dir, 'audio.mp3');
      await downloadObjectToFile(tempKey, src);
      let probe;
      try {
        probe = await probeMedia(src);
      } catch (e) {
        if (e instanceof MediaUnreadableError) throw new SttFailure('MEDIA_UNREADABLE');
        throw e;
      }
      if (!probe.hasAudio) throw new SttFailure('NO_AUDIO_STREAM');
      if (probe.durationMs != null) await log('info', 'probed', { sec: Math.round(probe.durationMs / 1000) });
      // FR-001: tối đa 60 phút — kiểm tra TRƯỚC khi gửi Soniox (không phát sinh chi phí)
      if (probe.durationMs != null && probe.durationMs > MAX_MEDIA_DURATION_MS) throw new SttFailure('MEDIA_TOO_LONG');
      await log('info', 'extracting');
      try {
        await extractAudioToMp3File(src, out);
      } catch (e) {
        if (e instanceof NoAudioStreamError) throw new SttFailure('NO_AUDIO_STREAM');
        throw new SttFailure('MEDIA_UNREADABLE');
      }
      const size = (await stat(out)).size;
      await log('info', 'extracted', { kb: Math.round(size / 1024) });

      await stage('uploading', 20);
      await log('info', 'uploading');
      const audio = await readFile(out);
      const baseName = job.originalFileName.replace(/\.[^.]+$/, '') || 'audio';
      const { fileId } = await withRetry(() => c.uploadAudioFile(audio, `${baseName}.mp3`));
      ids.fileId = fileId;
      await stage('uploading', 30, { sonioxFileId: fileId, tempStorageKey: null });
      await log('info', 'uploaded');
      // File tạm không còn cần sau khi Soniox đã có bản âm thanh (FR-006)
      await deleteTempMedia(tempKey);
      tempKey = null;
    }

    // ---- 2) Tạo transcription (bỏ qua khi tiếp tục và đã có) ---------------------------------------
    if (!ids.transcriptionId) {
      const fileId = ids.fileId!;
      const { transcriptionId } = await withRetry(() =>
        c.startTranscription(fileId, {
          model,
          languageHints: job.language && job.language !== 'auto' ? [job.language] : undefined,
          enableSpeakerDiarization: job.enableDiarization,
          clientReferenceId: jobId,
        }),
      );
      ids.transcriptionId = transcriptionId;
      await stage('transcribing', 35, { sonioxTranscriptionId: transcriptionId, model });
    } else {
      await stage('transcribing', 35);
    }
    await log('info', 'transcribing', { model });

    // ---- 3) Poll tới khi xong --------------------------------------------------------------------
    const transcriptionId = ids.transcriptionId!;
    const started = Date.now();
    let waitMs = opts.pollMs ?? 2000;
    let audioDurationMs: number | null = null;
    let progress = 35;
    for (;;) {
      const t = await withRetry(() => c.getTranscription(transcriptionId));
      if (typeof t.audio_duration_ms === 'number' && t.audio_duration_ms > 0) audioDurationMs = t.audio_duration_ms;
      if (t.status === 'completed') break;
      if (t.status === 'error' || t.status === 'failed') {
        await recordSttUsage({ userId: job.ownerId, projectId: job.projectId, sttJobId: jobId, model, audioSeconds: 0, pricePerAudioHourUsd: null, ok: false }).catch(() => undefined);
        throw new SttFailure('SONIOX_FAILED', t.error_type ?? undefined);
      }
      if (Date.now() - started > (opts.pollTimeoutMs ?? 2 * 3600_000)) throw new SttFailure('SONIOX_UNAVAILABLE', 'poll timeout');
      progress = Math.min(80, progress + 3);
      await stage('transcribing', progress);
      await sleep(waitMs, controller.signal).catch(() => {
        throw new JobGone();
      });
      waitMs = Math.min(opts.maxPollMs ?? 5000, Math.round(waitMs * 1.25));
    }

    const transcript = await withRetry(() => c.getTranscript(transcriptionId));
    const tokens: SonioxToken[] = transcript.tokens;
    const hasSpeech = tokens.some((tk) => !tk.is_audio_event && tk.translation_status !== 'translation' && tk.text.trim().length > 0);
    // Một bản ghi tính phí cho lần phiên âm (kể cả khi không có giọng nói: Soniox vẫn tính thời lượng)
    await recordSttUsage({
      userId: job.ownerId,
      projectId: job.projectId,
      sttJobId: jobId,
      model,
      audioSeconds: audioDurationMs != null ? Math.round(audioDurationMs / 1000) : null,
      transcriptChars: [...(transcript.text ?? '')].length,
      pricePerAudioHourUsd: cfg.pricePerAudioHourUsd,
      ok: true,
    });
    await stage('formatting', 85, { audioDurationMs });
    if (audioDurationMs != null) await log('info', 'transcribed', { sec: Math.round(audioDurationMs / 1000) });
    if (!hasSpeech) throw new SttFailure('NO_SPEECH_DETECTED');

    // ---- 4) Tạo tệp kết quả và nạp vào Project ---------------------------------------------------
    await log('info', 'formatting', { format: `.${job.targetFormat}` });
    const content =
      job.targetFormat === 'txt'
        ? chunkTokensToTxt(tokens)
        : job.targetFormat === 'md'
          ? chunkTokensToMd(tokens, {
              title: job.targetFileName.replace(/\.md$/i, ''),
              diarization: job.enableDiarization,
              speakerLabel: (n) => fmt(dict.stt.speaker, { n }),
            })
          : chunkTokensToSrt(tokens);
    if (!content.trim()) throw new SttFailure('NO_SPEECH_DETECTED');

    let saved;
    try {
      saved = await uploadScript(job.ownerId, job.projectId, { name: job.targetFileName, bytes: new TextEncoder().encode(content) });
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) throw new JobGone(); // Project vừa bị xóa
      throw new SttFailure('RESULT_SAVE_FAILED', e instanceof HttpError ? e.code : undefined);
    }
    await log('info', 'saved', { file: job.targetFileName });

    // ---- 5) Dọn dữ liệu tạm (MinIO + Soniox) rồi hoàn tất -----------------------------------------
    // File tạm có thể còn sót khi tiếp tục sau gián đoạn (worker chết ngay sau upload)
    if (tempKey && (await deleteTempMedia(tempKey))) tempKey = null;
    if (!(await deleteSonioxData(ids))) await log('warn', 'cleanupWarn');
    const done = await db
      .update(sttJobs)
      .set({
        ...(tempKey === null ? { tempStorageKey: null } : {}),
        status: 'completed',
        progressPercent: 100,
        stageMessage: 'completed',
        resultSubtitleFileId: saved.id,
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(sttJobs.id, jobId), inArray(sttJobs.status, [...STT_RUNNING_STATUSES])))
      .returning({ id: sttJobs.id });
    if (done.length > 0) await log('info', 'completed');
  } catch (e) {
    if (e instanceof JobGone || gone) {
      // Project/User đã bị xóa: không còn bản ghi để cập nhật; chỉ dọn dữ liệu tạm
      await deleteTempMedia(tempKey);
      await deleteSonioxData(ids);
      return;
    }
    const failure =
      e instanceof SttFailure ? e : e instanceof ProviderError ? providerFailure(e) : (console.error('[stt] lỗi không mong đợi:', e instanceof Error ? e.message : e), new SttFailure('INTERNAL'));
    const message = vi.stt.errors[failure.code];
    await log('error', 'failed', { reason: failure.code });
    await db
      .update(sttJobs)
      .set({ status: 'failed', errorCode: failure.code, errorMessage: message, stageMessage: 'failed', finishedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(sttJobs.id, jobId), inArray(sttJobs.status, [...STT_RUNNING_STATUSES])));
    // Dọn: file tạm và dữ liệu trên Soniox (FR-021); lỗi dọn chỉ ghi cảnh báo
    if (await deleteTempMedia(tempKey)) {
      await db.update(sttJobs).set({ tempStorageKey: null }).where(eq(sttJobs.id, jobId)).catch(() => undefined);
    }
    if (!(await deleteSonioxData(ids))) await log('warn', 'cleanupWarn');
  } finally {
    clearInterval(hb);
    await rm(dir, { recursive: true, force: true });
  }
}

/** Hệ thống chỉ chạy tối đa 2 STT job đồng thời trên mỗi worker; phần dư nằm chờ trong hàng đợi (Nguyên tắc III). */
export const STT_LOCAL_CONCURRENCY = 2;

export async function registerTranscribeMedia(boss: PgBoss): Promise<void> {
  await boss.work<TranscribeMediaPayload>(QUEUES.transcribeMedia, { localConcurrency: STT_LOCAL_CONCURRENCY }, async (jobs) => {
    for (const j of jobs) await runTranscribeMedia(j.data.jobId);
  });
}
