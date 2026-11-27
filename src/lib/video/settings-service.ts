import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { notFound } from '../api/errors';
import { getDb, type Db } from '../db';
import { videoJobs, videoProjectSettings } from '../db/schema';
import { getOwnedProject } from '../projects/access';
import { recomputeSourceExpiry } from './expiry';
import { getOwnedVideoJob, projectVideoSettings, type VideoProjectSettingsDto } from './service';
import { normalizeStyle, videoStyleSchema, type VideoStyle } from './style';
import { DIRECTIONS, type Direction } from './types';

/** Cài đặt dịch video của Project và kiểu phụ đề của việc (spec 006, T098; FR-019, FR-031). */

type Change = { direction?: Direction; style?: VideoStyle | null };

async function upsertProjectSettings(ownerId: string, projectId: string, change: Change, db: Db): Promise<void> {
  const set = { ...change, updatedAt: new Date() };
  await db
    .insert(videoProjectSettings)
    .values({ projectId, ownerId, ...set })
    .onConflictDoUpdate({ target: videoProjectSettings.projectId, set });
}

const projectSchema = z
  .object({
    direction: z.enum(DIRECTIONS).optional(),
    /** `null`: đưa kiểu gần nhất về mặc định */
    style: videoStyleSchema.nullable().optional(),
  })
  .strict()
  .refine((v) => v.direction !== undefined || v.style !== undefined);

/** Chỉ đổi những trường được gửi. Không đụng kiểu của các việc đã có. */
export async function saveProjectVideoSettings(ownerId: string, projectId: string, raw: unknown): Promise<VideoProjectSettingsDto> {
  await getOwnedProject(ownerId, projectId);
  const body = projectSchema.parse(raw);
  const change: Change = {
    ...(body.direction === undefined ? {} : { direction: body.direction }),
    ...(body.style === undefined ? {} : { style: body.style === null ? null : normalizeStyle(body.style).style }),
  };
  await upsertProjectSettings(ownerId, projectId, change, getDb());
  return projectVideoSettings(projectId);
}

/**
 * Lưu kiểu của một việc, đồng thời làm kiểu gần nhất của Project. Đổi kiểu là một hoạt động trên việc nên hạn xóa video nguồn được tính
 * lại trong cùng giao dịch. Không cần quyền Dịch Video: sửa dữ liệu đã có.
 */
export async function saveJobStyle(ownerId: string, jobId: string, raw: unknown): Promise<{ style: VideoStyle; changed: string[] }> {
  await getOwnedVideoJob(ownerId, jobId);
  const { style, changed } = normalizeStyle(videoStyleSchema.parse(raw));
  await getDb().transaction(async (tx) => {
    const db = tx as unknown as Db;
    const now = new Date();
    const [job] = await tx
      .update(videoJobs)
      .set({ style, lastActivityAt: now, updatedAt: now })
      .where(and(eq(videoJobs.id, jobId), eq(videoJobs.ownerId, ownerId)))
      .returning({ projectId: videoJobs.projectId });
    if (!job) throw notFound();
    await upsertProjectSettings(ownerId, job.projectId, { style }, db);
    await recomputeSourceExpiry(jobId, db);
  });
  return { style, changed };
}
