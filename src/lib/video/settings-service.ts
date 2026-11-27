import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { HttpError, notFound } from '../api/errors';
import { getDb, type Db } from '../db';
import { videoJobs, videoProjectSettings } from '../db/schema';
import { getOwnedProject } from '../projects/access';
import { getSettings } from '../settings';
import { recomputeSourceExpiry } from './expiry';
import { validateGlossary } from './glossary';
import { getOwnedVideoJob, projectVideoSettings, type VideoProjectSettingsDto } from './service';
import { normalizeStyle, videoStyleSchema, type VideoStyle } from './style';
import { DIRECTIONS, type Direction, type GlossaryPair } from './types';

/** Cài đặt dịch video của Project và kiểu phụ đề của việc (spec 006, T098; FR-019, FR-031). */

type Change = { direction?: Direction; glossary?: GlossaryPair[]; style?: VideoStyle | null };

async function upsertProjectSettings(ownerId: string, projectId: string, change: Change, db: Db): Promise<void> {
  const set = { ...change, updatedAt: new Date() };
  await db
    .insert(videoProjectSettings)
    .values({ projectId, ownerId, ...set })
    .onConflictDoUpdate({ target: videoProjectSettings.projectId, set });
}

/** Trần chống thân yêu cầu quá lớn; giới hạn thật đọc từ cài đặt. */
const glossarySchema = z.array(z.object({ source: z.string().max(1000), target: z.string().max(1000), keep: z.boolean() }).strict()).max(5000);

const projectSchema = z
  .object({
    direction: z.enum(DIRECTIONS).optional(),
    glossary: glossarySchema.optional(),
    /** `null`: đưa kiểu gần nhất về mặc định */
    style: videoStyleSchema.nullable().optional(),
  })
  .strict()
  .refine((v) => v.direction !== undefined || v.glossary !== undefined || v.style !== undefined);

/** Từ điển đã chuẩn hóa theo giới hạn trong cài đặt; sai thì 422, không nhận một phần. */
async function checkedGlossary(pairs: GlossaryPair[]): Promise<GlossaryPair[]> {
  const s = await getSettings();
  const check = validateGlossary(pairs, { maxPairs: s.videoGlossaryMaxPairs, maxChars: s.videoGlossaryMaxChars });
  if (check.ok) return check.pairs;
  // khóa là thứ tự cặp, giá trị là mã lý do để giao diện nói đúng dòng
  throw new HttpError(422, check.code, undefined, check.errors.length > 0 ? Object.fromEntries(check.errors.map((e) => [String(e.line), e.reason])) : undefined);
}

/** Chỉ đổi những trường được gửi. Không đụng kiểu của các việc đã có. */
export async function saveProjectVideoSettings(ownerId: string, projectId: string, raw: unknown): Promise<VideoProjectSettingsDto> {
  await getOwnedProject(ownerId, projectId);
  const body = projectSchema.parse(raw);
  const change: Change = {
    ...(body.direction === undefined ? {} : { direction: body.direction }),
    ...(body.glossary === undefined ? {} : { glossary: await checkedGlossary(body.glossary) }),
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
