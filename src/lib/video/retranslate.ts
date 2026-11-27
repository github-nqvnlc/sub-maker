import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { HttpError } from '../api/errors';
import { videoJobs } from '../db/schema';
import { getSttConfigRow } from '../stt/config';
import { estimateSttCostUsd } from '../usage/record';
import { recomputeSourceExpiry } from './expiry';
import { appendVideoLog } from './log';
import { requireVideoPermission, type VideoPrincipal } from './permission';
import { providerSnapshot, releaseProviderData } from './provider-data';
import { assertJobSlot, withVideoLock } from './quota';
import { enqueuePipeline, getOwnedVideoJob, nextPipelineStep, projectVideoSettings, toDto, type VideoJobDto } from './service';
import { cuesEditable } from './status';
import { DIRECTIONS } from './types';

/**
 * Dịch lại một việc đã có phụ đề (spec 006, T105; FR-016, FR-021). Gọi lại nhà cung cấp nên phát sinh phí và thay toàn bộ cue: yêu cầu
 * xác nhận, đúng phiên bản phụ đề đang thấy, và dùng hướng dịch cùng từ điển hiện tại. Cue cũ giữ nguyên tới khi lượt mới lưu xong.
 */

export type RetranslateEstimateDto = { durationMs: number; costEstimateUsd: number | null };

export async function estimateRetranslate(ownerId: string, jobId: string): Promise<RetranslateEstimateDto> {
  const job = await getOwnedVideoJob(ownerId, jobId);
  if (!job.media) throw new HttpError(409, 'VIDEO_NOT_EDITABLE');
  const durationMs = job.media.audioDurationMs || job.media.durationMs;
  const cfg = await getSttConfigRow();
  return { durationMs, costEstimateUsd: estimateSttCostUsd(Math.round(durationMs / 1000), cfg?.pricePerAudioHourUsd ?? null) };
}

const bodySchema = z.object({ confirm: z.literal(true), direction: z.enum(DIRECTIONS), baseRevision: z.number().int().min(0) }).strict();

export async function retranslateVideoJob(user: VideoPrincipal & { id: string }, jobId: string, raw: unknown): Promise<VideoJobDto> {
  const job = await getOwnedVideoJob(user.id, jobId);
  requireVideoPermission(user);
  const body = bodySchema.parse(raw);
  if (!cuesEditable(job) || job.sourceState === 'rejected') throw new HttpError(409, 'VIDEO_NOT_EDITABLE');
  if (job.cueRevision !== body.baseRevision) throw new HttpError(409, 'CUE_CONFLICT', undefined, { revision: String(job.cueRevision) });
  // đã tách âm thanh thì dịch thẳng; nếu âm thanh trình duyệt lệch nguồn và nguồn sẵn sàng thì tách lại từ nguồn
  const clearMismatchedAudio = job.audioMismatch && job.sourceState === 'ready';
  const step = clearMismatchedAudio ? 'prepare' : nextPipelineStep(job);
  if (step === 'prepare' && job.sourceState !== 'ready' && job.sourceState !== 'checking') throw new HttpError(409, 'VIDEO_SOURCE_GONE');
  if (!(await getSttConfigRow())?.enabled) throw new HttpError(409, 'STT_NOT_CONFIGURED');
  // dữ liệu của lượt trước còn ở nhà cung cấp thì lấy và xóa trước khi quên id (FR-017)
  if (!(await releaseProviderData(providerSnapshot(job)))) throw new HttpError(409, 'CONFLICT');
  const prefs = await projectVideoSettings(job.projectId);

  const updated = await withVideoLock(async (tx) => {
    await assertJobSlot(tx, user.id, { excludeJobId: job.id });
    const now = new Date();
    const [row] = await tx
      .update(videoJobs)
      .set({
        status: 'queued',
        stageKey: 'queued',
        errorCode: null,
        cancelRequested: false,
        interruptions: 0,
        heartbeatAt: null,
        finishedAt: null,
        progressPercent: step === 'translate' ? 10 : 0,
        ...(clearMismatchedAudio ? { audioTempKey: null, clientAudio: false } : {}),
        audioMismatch: false,
        translationRun: job.translationRun + 1,
        sonioxFileId: null,
        sonioxTranscriptionId: null,
        direction: body.direction,
        glossary: prefs.glossary,
        lastActivityAt: now,
        updatedAt: now,
      })
      // hai lần bấm hoặc một lần sửa phụ đề xen giữa: chỉ một yêu cầu khớp
      .where(
        and(
          eq(videoJobs.id, job.id),
          inArray(videoJobs.status, ['review_ready', 'failed', 'stopped']),
          eq(videoJobs.cueRevision, body.baseRevision),
          eq(videoJobs.translationRun, job.translationRun),
        ),
      )
      .returning();
    if (row) await recomputeSourceExpiry(job.id, tx);
    return row;
  });
  if (!updated) throw new HttpError(409, 'CONFLICT');
  await appendVideoLog(job.id, 'info', 'retranslate');
  await enqueuePipeline(updated).catch((e) => console.error('[video] không xếp được việc dịch lại:', e instanceof Error ? e.message : e));
  return toDto(updated);
}
