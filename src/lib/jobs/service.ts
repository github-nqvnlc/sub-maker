import { and, asc, desc, eq, gt, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../db';
import { jobLogs, jobSegments, voiceJobs, voices } from '../db/schema';
import { HttpError, notFound, validation } from '../api/errors';
import { appendLogSafe } from './log';
import type { AuthUser } from '../auth/guards';
import { resolveConfigForJob } from '../providers/config-service';
import { resolveSettings } from '../providers/catalog';
import { getOwnedFile, getOwnedJob, getOwnedProject } from '../projects/access';
import { jobDto } from '../projects/dto';
import { hasQuotaFor, QuotaExceededError } from '../storage/quota';
import { enqueueGenerateVoice } from '../../worker/queues';
import { jobStatusSchema } from '../schemas/common';

export const createJobSchema = z
  .object({
    fileId: z.string().uuid(),
    model: z.string().trim().max(100).nullable().optional(),
    voice: z.string().trim().max(100).nullable().optional(),
    speed: z.number().finite().nullable().optional(),
  })
  .strict();
export type CreateJobInput = z.infer<typeof createJobSchema>;

const SEGMENT_CHUNK = 1000;

/** Bắt đầu tạo voice (FR-012, FR-015): kiểm tra cấu hình khả dụng, thiết lập hợp lệ, hạn mức; rồi xếp hàng. */
export async function createJob(user: AuthUser, projectId: string, input: CreateJobInput) {
  const project = await getOwnedProject(user.id, projectId);
  const file = await getOwnedFile(user.id, input.fileId);
  if (file.projectId !== project.id) throw notFound();

  // 409 PROVIDER_NOT_CONFIGURED nếu không có cấu hình riêng/chung khả dụng
  const resolved = await resolveConfigForJob(user, project.providerType);
  const parsed = resolveSettings(project.providerType, {
    model: input.model,
    voice: input.voice,
    speed: input.speed,
    defaults: { model: resolved.row.defaultModel, voice: resolved.row.defaultVoice, speed: resolved.row.defaultSpeed },
  });
  if (!parsed.ok) throw validation(parsed.fields);

  // Hạn mức chặt lúc tạo job mới (job đang chạy được phép hoàn tất)
  if (!(await hasQuotaFor(user.id, 1))) throw new QuotaExceededError();

  const db = getDb();
  const job = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(voiceJobs)
      .values({
        projectId: project.id,
        ownerId: user.id,
        subtitleFileId: file.id,
        status: 'queued',
        providerType: project.providerType,
        configId: resolved.row.id,
        configScope: resolved.scope,
        settings: { model: parsed.value.model, voice: parsed.value.voice, speed: parsed.value.speed },
        progressTotal: file.segmentCount,
      })
      .returning();
    for (let i = 0; i < file.segmentCount; i += SEGMENT_CHUNK) {
      const n = Math.min(SEGMENT_CHUNK, file.segmentCount - i);
      await tx.insert(jobSegments).values(Array.from({ length: n }, (_, k) => ({ jobId: row!.id, idx: i + k })));
    }
    return row!;
  });

  await appendLogSafe(job.id, 'info', 'JOB_QUEUED', 'Đã xếp hàng, đang chờ worker xử lý');
  try {
    const queueId = await enqueueGenerateVoice(job.id);
    if (queueId) await db.update(voiceJobs).set({ queueJobId: queueId }).where(eq(voiceJobs.id, job.id));
  } catch {
    await db.update(voiceJobs).set({ status: 'failed', errorCode: 'QUEUE_UNAVAILABLE', errorMessage: 'Không đưa được tiến trình vào hàng đợi. Hãy thử lại sau.', finishedAt: new Date() }).where(eq(voiceJobs.id, job.id));
    throw new HttpError(503, 'INTERNAL', 'Hệ thống tạm thời chưa nhận được việc mới. Hãy thử lại sau ít phút.');
  }
  const [fresh] = await db.select().from(voiceJobs).where(eq(voiceJobs.id, job.id));
  return jobDto(fresh!);
}

async function voiceIdsByJob(jobIds: string[]): Promise<Map<string, string>> {
  if (jobIds.length === 0) return new Map();
  const rows = await getDb().select({ jobId: voices.jobId, id: voices.id }).from(voices).where(inArray(voices.jobId, jobIds));
  return new Map(rows.map((r) => [r.jobId, r.id]));
}

export async function listProjectJobs(ownerId: string, projectId: string) {
  await getOwnedProject(ownerId, projectId);
  const rows = await getDb().select().from(voiceJobs).where(and(eq(voiceJobs.projectId, projectId), eq(voiceJobs.ownerId, ownerId))).orderBy(desc(voiceJobs.createdAt));
  const v = await voiceIdsByJob(rows.map((r) => r.id));
  return rows.map((r) => jobDto(r, v.get(r.id) ?? null));
}

/** Tiến trình của tôi xuyên mọi Project (cho chỉ báo "đang chạy"), lọc theo trạng thái. */
export async function listMyJobs(ownerId: string, statusParam: string | undefined, limit: number) {
  const statuses = statusParam
    ? statusParam
        .split(',')
        .map((s) => jobStatusSchema.safeParse(s.trim()))
        .filter((r) => r.success)
        .map((r) => r.data!)
    : [];
  if (statusParam && statuses.length === 0) throw validation({ status: 'Trạng thái không hợp lệ' });
  const where = statuses.length ? and(eq(voiceJobs.ownerId, ownerId), inArray(voiceJobs.status, statuses)) : eq(voiceJobs.ownerId, ownerId);
  const rows = await getDb().select().from(voiceJobs).where(where).orderBy(desc(voiceJobs.createdAt)).limit(limit);
  const v = await voiceIdsByJob(rows.map((r) => r.id));
  return rows.map((r) => jobDto(r, v.get(r.id) ?? null));
}

export async function getJobDetail(ownerId: string, jobId: string) {
  const job = await getOwnedJob(ownerId, jobId);
  const db = getDb();
  const failed = await db
    .select({ idx: jobSegments.idx, errorCode: jobSegments.errorCode })
    .from(jobSegments)
    .where(and(eq(jobSegments.jobId, jobId), eq(jobSegments.status, 'failed')))
    .orderBy(asc(jobSegments.idx));
  const v = await voiceIdsByJob([jobId]);
  return { ...jobDto(job, v.get(jobId) ?? null), failedSegments: failed.map((f) => ({ idx: f.idx, errorCode: f.errorCode ?? 'UNKNOWN' })) };
}

export type LogDto = { id: number; ts: string; level: 'info' | 'warn' | 'error'; code: string; message: string; meta: Record<string, unknown> | null };

export const logDto = (l: typeof jobLogs.$inferSelect): LogDto => ({
  id: l.id,
  ts: l.ts.toISOString(),
  level: l.level,
  code: l.code,
  message: l.message,
  meta: l.meta ?? null,
});

/** Đọc log theo con trỏ `after` (dự phòng khi SSE không dùng được). */
export async function readLogs(ownerId: string, jobId: string, after: number, limit: number) {
  const job = await getOwnedJob(ownerId, jobId);
  const rows = await getDb()
    .select()
    .from(jobLogs)
    .where(and(eq(jobLogs.jobId, jobId), gt(jobLogs.id, after)))
    .orderBy(asc(jobLogs.id))
    .limit(limit);
  return { items: rows.map(logDto), status: job.status };
}
