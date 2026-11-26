import { eq } from 'drizzle-orm';
import { getDb, type Db } from '@/lib/db';
import { users, videoExports, videoJobs, videoUploads } from '@/lib/db/schema';
import type { TestUser } from './helpers';

/** Hàm dùng chung cho kiểm thử dịch video (spec 006): chèn thẳng bản ghi, cấp quyền, đọc bộ đếm. */

export type VideoJobInsert = Partial<typeof videoJobs.$inferInsert>;

export async function insertVideoJob(ownerId: string, projectId: string, over: VideoJobInsert = {}, db: Db = getDb()) {
  const [row] = await db
    .insert(videoJobs)
    .values({ projectId, ownerId, originalFileName: 'phim.mp4', ext: 'mp4', fileSizeBytes: 1000, fingerprint: 'a'.repeat(64), direction: 'to_vi', ...over })
    .returning();
  return row!;
}

export async function insertUpload(jobId: string, ownerId: string, over: Partial<typeof videoUploads.$inferInsert> = {}) {
  const [row] = await getDb()
    .insert(videoUploads)
    .values({
      jobId,
      ownerId,
      kind: 'source',
      storageUploadId: 'x',
      key: `users/${ownerId}/video/${jobId}/source.mp4`,
      sizeBytes: 1000,
      partSize: 16 * 1024 * 1024,
      partCount: 1,
      fingerprint: 'a'.repeat(64),
      expiresAt: new Date(Date.now() + 48 * 3600_000),
      ...over,
    })
    .returning();
  return row!;
}

export async function insertExport(jobId: string, ownerId: string, over: Partial<typeof videoExports.$inferInsert> = {}) {
  const [row] = await getDb()
    .insert(videoExports)
    .values({ jobId, ownerId, kind: 'burn', format: 'mp4', style: {} as never, cues: [], cueRevision: 0, estimatedBytes: 1000, durationMs: 1000, ...over })
    .returning();
  return row!;
}

export const videoUsed = async (userId: string): Promise<number> => (await getDb().select({ n: users.videoUsedBytes }).from(users).where(eq(users.id, userId)))[0]!.n;

export const videoJobRow = async (id: string) => (await getDb().select().from(videoJobs).where(eq(videoJobs.id, id)))[0];

export async function grantVideo(admin: TestUser, userId: string, allowed = true): Promise<void> {
  const res = await admin.client.patch(`/api/admin/users/${userId}`, { json: { canTranslateVideo: allowed } });
  if (!res.ok) throw new Error(`grantVideo: ${res.status} ${await res.text()}`);
}

export const errorOf = async (r: Response) => ((await r.json()) as { error: { code: string; message: string; fields?: Record<string, string> } }).error;
