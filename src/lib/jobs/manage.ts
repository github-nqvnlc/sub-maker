import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../db';
import { jobSegments, voiceJobs } from '../db/schema';
import { conflict, validation } from '../api/errors';
import type { AuthUser } from '../auth/guards';
import { resolveSettings } from '../providers/catalog';
import { resolveConfigForJob } from '../providers/config-service';
import { getOwnedJob } from '../projects/access';
import { jobDto } from '../projects/dto';
import { enqueueGenerateVoice } from '../../worker/queues';
import { createJob } from './service';
import { appendLogSafe } from './log';

/**
 * Quản lý tiến trình (US4, FR-021..023):
 *  - tiếp tục (stopped|failed|interrupted) cùng một tiến trình, bỏ qua đoạn đã xong;
 *  - sửa thiết lập (chỉ khi stopped|failed|interrupted) — đổi thiết lập thì đưa mọi đoạn về `pending`
 *    (đoạn có cùng hash vẫn lấy từ cache) để voice cuối không trộn nhiều giọng/tốc độ;
 *  - chạy lại: tạo tiến trình MỚI (kể cả từ tiến trình đã hoàn tất) với thiết lập tùy chọn.
 */

const RESUMABLE = ['stopped', 'failed', 'interrupted'] as const;

export const settingsPatchSchema = z
  .object({
    model: z.string().trim().max(100).nullable().optional(),
    voice: z.string().trim().max(100).nullable().optional(),
    speed: z.number().finite().nullable().optional(),
  })
  .strict();
export type SettingsPatch = z.infer<typeof settingsPatchSchema>;

export async function resumeJob(user: AuthUser, jobId: string) {
  const job = await getOwnedJob(user.id, jobId);
  if (!(RESUMABLE as readonly string[]).includes(job.status)) {
    throw conflict('CONFLICT', 'Chỉ tiếp tục được tiến trình đã dừng, bị lỗi hoặc bị gián đoạn.');
  }
  const db = getDb();
  const [row] = await db
    .update(voiceJobs)
    .set({ status: 'queued', cancelRequested: false, errorCode: null, errorMessage: null, finishedAt: null })
    .where(and(eq(voiceJobs.id, jobId), eq(voiceJobs.ownerId, user.id), inArray(voiceJobs.status, [...RESUMABLE])))
    .returning();
  if (!row) throw conflict('CONFLICT', 'Trạng thái tiến trình vừa thay đổi, hãy tải lại trang.');
  await appendLogSafe(jobId, 'info', 'JOB_QUEUED', 'Đã xếp hàng lại để tiếp tục từ các đoạn chưa xong');
  const queueId = await enqueueGenerateVoice(jobId);
  if (queueId) await db.update(voiceJobs).set({ queueJobId: queueId }).where(eq(voiceJobs.id, jobId));
  return jobDto(row);
}

export async function updateJobSettings(user: AuthUser, jobId: string, patch: SettingsPatch) {
  const job = await getOwnedJob(user.id, jobId);
  if (!(RESUMABLE as readonly string[]).includes(job.status)) {
    throw conflict('CONFLICT', 'Chỉ sửa được thiết lập khi tiến trình đã dừng, bị lỗi hoặc bị gián đoạn (hãy dừng trước). Với tiến trình đã hoàn tất, hãy chạy lại với thiết lập mới.');
  }
  if (Object.keys(patch).length === 0) throw validation({ _: 'Không có thay đổi nào' });

  const resolved = await resolveConfigForJob(user, job.providerType);
  const parsed = resolveSettings(job.providerType, {
    model: patch.model !== undefined ? patch.model : job.settings.model,
    voice: patch.voice !== undefined ? patch.voice : job.settings.voice,
    speed: patch.speed !== undefined ? patch.speed : job.settings.speed,
    defaults: { model: resolved.row.defaultModel, voice: resolved.row.defaultVoice, speed: resolved.row.defaultSpeed },
  });
  if (!parsed.ok) throw validation(parsed.fields);

  const next = { ...job.settings, model: parsed.value.model, voice: parsed.value.voice, speed: parsed.value.speed };
  const changed = next.model !== (job.settings.model ?? null) || next.voice !== job.settings.voice || next.speed !== (job.settings.speed ?? null);
  const db = getDb();
  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(voiceJobs)
      .set({ settings: next, ...(changed ? { progressDone: 0 } : {}) })
      .where(and(eq(voiceJobs.id, jobId), eq(voiceJobs.ownerId, user.id), inArray(voiceJobs.status, [...RESUMABLE])))
      .returning();
    if (!row) throw conflict('CONFLICT', 'Trạng thái tiến trình vừa thay đổi, hãy tải lại trang.');
    if (changed) {
      // Đổi giọng/tốc độ/model: mọi đoạn phải làm lại với thiết lập mới (đoạn trùng hash vẫn lấy từ cache, không tốn phí lặp)
      await tx.update(jobSegments).set({ status: 'pending', cacheHit: false, audioCacheId: null, durationMs: null, errorCode: null }).where(eq(jobSegments.jobId, jobId));
    }
    return row;
  });
  if (changed) await appendLogSafe(jobId, 'info', 'SETTINGS_CHANGED', `Đã đổi thiết lập: giọng ${next.voice}${next.model ? `, model ${next.model}` : ''}${next.speed != null ? `, tốc độ ${next.speed}` : ''}. Các đoạn sẽ được tạo lại khi tiếp tục.`);
  return jobDto(updated);
}

/** Chạy lại: tạo tiến trình mới từ tiến trình cũ (cùng tệp), thiết lập tùy chọn ghi đè lên thiết lập cũ. */
export async function rerunJob(user: AuthUser, jobId: string, overrides: SettingsPatch) {
  const job = await getOwnedJob(user.id, jobId);
  return createJob(user, job.projectId, {
    fileId: job.subtitleFileId,
    model: overrides.model !== undefined ? overrides.model : (job.settings.model ?? null),
    voice: overrides.voice !== undefined ? overrides.voice : job.settings.voice,
    speed: overrides.speed !== undefined ? overrides.speed : (job.settings.speed ?? null),
  });
}
