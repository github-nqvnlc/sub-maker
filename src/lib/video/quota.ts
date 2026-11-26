import { and, eq, inArray, isNotNull, ne, sql, type SQL } from 'drizzle-orm';
import { HttpError } from '../api/errors';
import { getDb, type Db } from '../db';
import { users, VIDEO_EXPORT_ACTIVE, VIDEO_PIPELINE_ACTIVE, videoExports, videoJobs, videoUploads } from '../db/schema';
import { getSettings } from '../settings';

/**
 * Hạn mức video (spec 006, data-model §3.2, research R12; FR-007, FR-008, FR-053).
 * Chỗ giữ trước SUY RA từ phiên tải video nguồn đang mở và bản xuất đang chờ/chạy, nên không thể "kẹt" chỗ khi tiến trình chết.
 * Mọi kiểm tra đi kèm thao tác tạo phải nằm trong `withVideoLock` để nhiều yêu cầu đồng thời không cùng vượt.
 * Khóa dùng chung cho cả hệ thống (không riêng từng User) vì còn phải giữ trần dung lượng hệ thống.
 */
const VIDEO_QUOTA_LOCK = 727_010;

export class VideoQuotaExceededError extends HttpError {
  /** `needBytes`: cần giải phóng thêm bao nhiêu. */
  constructor(needBytes: number, remainingBytes: number) {
    super(409, 'VIDEO_QUOTA_EXCEEDED', undefined, { needBytes: String(Math.ceil(needBytes)), remainingBytes: String(Math.floor(remainingBytes)) });
    this.name = 'VideoQuotaExceededError';
  }
}

export async function withVideoLock<T>(fn: (tx: Db) => Promise<T>, db: Db = getDb()): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${VIDEO_QUOTA_LOCK})`);
    return fn(tx as unknown as Db);
  });
}

const num = (v: string | number | null | undefined) => Number(v ?? 0);

async function sumUploads(db: Db, where: SQL | undefined): Promise<number> {
  const [r] = await db
    .select({ n: sql<string>`coalesce(sum(${videoUploads.sizeBytes}), 0)` })
    .from(videoUploads)
    .where(and(eq(videoUploads.kind, 'source'), inArray(videoUploads.state, ['active', 'completing']), where));
  return num(r?.n);
}

async function sumExports(db: Db, where: SQL | undefined): Promise<number> {
  const [r] = await db
    .select({ n: sql<string>`coalesce(sum(${videoExports.estimatedBytes}), 0)` })
    .from(videoExports)
    .where(and(inArray(videoExports.status, [...VIDEO_EXPORT_ACTIVE]), where));
  return num(r?.n);
}

/** Chỗ đang giữ của một User. */
export async function videoReservedBytes(userId: string, db: Db = getDb()): Promise<number> {
  return (await sumUploads(db, eq(videoUploads.ownerId, userId))) + (await sumExports(db, eq(videoExports.ownerId, userId)));
}

/** Dung lượng video toàn hệ thống: đã dùng + đang giữ + bản xem trước của mọi User. */
export async function videoSystemBytes(db: Db = getDb()): Promise<number> {
  const [used] = await db.select({ n: sql<string>`coalesce(sum(${users.videoUsedBytes}), 0)` }).from(users);
  const [preview] = await db
    .select({ n: sql<string>`coalesce(sum(${videoJobs.previewBytes}), 0)` })
    .from(videoJobs)
    .where(isNotNull(videoJobs.previewBytes));
  return num(used?.n) + num(preview?.n) + (await sumUploads(db, undefined)) + (await sumExports(db, undefined));
}

async function videoUsedOf(userId: string, db: Db): Promise<number> {
  const [r] = await db.select({ n: users.videoUsedBytes }).from(users).where(eq(users.id, userId));
  return r?.n ?? 0;
}

/** Số việc "đang chạy" của User: phiên tải mở, pipeline đang hoạt động hoặc bản xuất đang hoạt động; mỗi việc đếm một lần. */
export async function videoActiveJobCount(userId: string, opts: { excludeJobId?: string } = {}, db: Db = getDb()): Promise<number> {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(videoJobs)
    .where(
      and(
        eq(videoJobs.ownerId, userId),
        opts.excludeJobId ? ne(videoJobs.id, opts.excludeJobId) : undefined,
        sql`(${inArray(videoJobs.status, [...VIDEO_PIPELINE_ACTIVE])}
          or exists (select 1 from ${videoUploads} where ${videoUploads.jobId} = ${videoJobs.id} and ${inArray(videoUploads.state, ['active', 'completing'])})
          or exists (select 1 from ${videoExports} where ${videoExports.jobId} = ${videoJobs.id} and ${inArray(videoExports.status, [...VIDEO_EXPORT_ACTIVE])}))`,
      ),
    );
  return r?.n ?? 0;
}

export type VideoQuotaInfo = {
  quotaBytes: number;
  usedBytes: number;
  reservedBytes: number;
  remainingBytes: number;
  activeJobs: number;
  maxJobs: number;
};

export async function videoQuotaInfo(userId: string, db: Db = getDb()): Promise<VideoQuotaInfo> {
  const settings = await getSettings(db);
  const usedBytes = await videoUsedOf(userId, db);
  const reservedBytes = await videoReservedBytes(userId, db);
  return {
    quotaBytes: settings.userVideoQuotaBytes,
    usedBytes,
    reservedBytes,
    remainingBytes: Math.max(0, settings.userVideoQuotaBytes - usedBytes - reservedBytes),
    activeJobs: await videoActiveJobCount(userId, {}, db),
    maxJobs: settings.videoMaxJobsPerUser,
  };
}

/** Còn đủ chỗ cho thêm `needBytes` trong hạn mức của User và trong trần hệ thống. Gọi trong `withVideoLock`. */
export async function assertVideoRoom(tx: Db, userId: string, needBytes: number): Promise<void> {
  const settings = await getSettings(tx);
  const taken = (await videoUsedOf(userId, tx)) + (await videoReservedBytes(userId, tx));
  if (taken + needBytes > settings.userVideoQuotaBytes) {
    throw new VideoQuotaExceededError(taken + needBytes - settings.userVideoQuotaBytes, Math.max(0, settings.userVideoQuotaBytes - taken));
  }
  if ((await videoSystemBytes(tx)) + needBytes > settings.videoSystemCapBytes) throw new HttpError(409, 'VIDEO_SYSTEM_FULL');
}

/** User chưa chạy quá số việc cho phép; việc đang xét không tự chặn mình. Gọi trong `withVideoLock`. */
export async function assertJobSlot(tx: Db, userId: string, opts: { excludeJobId?: string } = {}): Promise<void> {
  const { videoMaxJobsPerUser } = await getSettings(tx);
  if ((await videoActiveJobCount(userId, opts, tx)) >= videoMaxJobsPerUser) throw new HttpError(429, 'VIDEO_TOO_MANY_JOBS');
}

/** Cộng (hoặc trừ) bộ đếm video đã dùng; không bao giờ âm. */
export async function addVideoUsed(userId: string, delta: number, db: Db = getDb()): Promise<void> {
  if (delta === 0) return;
  await db
    .update(users)
    .set({ videoUsedBytes: sql`greatest(0, ${users.videoUsedBytes} + ${delta})` })
    .where(eq(users.id, userId));
}
