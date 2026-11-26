import { createHash } from 'node:crypto';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { HttpError, notFound } from '../api/errors';
import { getDb, type Db } from '../db';
import { videoJobs, videoUploadParts, videoUploads } from '../db/schema';
import { isUuid } from '../projects/access';
import { abortMultipart, completeMultipart, deleteObject, getObjectRange, headObject, uploadPart } from '../storage/client';
import { enqueueVideoPrepare } from '../../worker/queues';
import { deleteVideoJobs } from './cleanup';
import { recomputeSourceExpiry } from './expiry';
import { fingerprintOf } from './fingerprint';
import { appendVideoLog } from './log';
import { requireVideoPermission, type VideoPrincipal } from './permission';
import { addVideoUsed, withVideoLock } from './quota';

/**
 * Tải video từng phần (spec 006, FR-004 đến FR-006, research R7): trình duyệt gửi từng phần 16 MB qua ứng dụng (kiểm đăng nhập,
 * quyền và chủ sở hữu ở MỖI phần), máy chủ kiểm độ dài và mã băm rồi chuyển thẳng vào phiên multipart của kho. Không bước nào giữ
 * cả tệp trong bộ nhớ. Phiên hết hạn 48 giờ sau phần gần nhất.
 */
export const VIDEO_PART_SIZE = 16 * 1024 * 1024;
export const UPLOAD_TTL_MS = 48 * 3600_000;
/** Số phần được giữ trong bộ nhớ cùng lúc (128 MB); quá thì trả 429 kèm Retry-After. */
export const MAX_PARTS_IN_MEMORY = 8;
export const RETRY_AFTER_SECONDS = 2;

export const partCountOf = (size: number, partSize = VIDEO_PART_SIZE): number => Math.max(1, Math.ceil(size / partSize));

export class UploadBusyError extends HttpError {
  constructor() {
    super(429, 'UPLOAD_BUSY');
    this.name = 'UploadBusyError';
  }
}

const holder = globalThis as unknown as { __submakerPartSlots?: { used: number } };
const slots = (holder.__submakerPartSlots ??= { used: 0 });

export type UploadRow = typeof videoUploads.$inferSelect;
type Principal = VideoPrincipal & { id: string };

export async function getOwnedUpload(ownerId: string, uploadId: string, db: Db = getDb()): Promise<UploadRow> {
  if (!isUuid(uploadId)) throw notFound();
  const [row] = await db
    .select()
    .from(videoUploads)
    .where(and(eq(videoUploads.id, uploadId), eq(videoUploads.ownerId, ownerId)))
    .limit(1);
  if (!row) throw notFound();
  return row;
}

const isOpen = (u: Pick<UploadRow, 'state' | 'expiresAt'>): boolean => (u.state === 'active' || u.state === 'completing') && u.expiresAt.getTime() > Date.now();

const closed = () => new HttpError(409, 'UPLOAD_CLOSED');
const mismatch = () => new HttpError(409, 'FILE_MISMATCH');

export type UploadStateDto = {
  id: string;
  jobId: string;
  kind: UploadRow['kind'];
  state: UploadRow['state'];
  size: number;
  partSize: number;
  partCount: number;
  expiresAt: string;
  /** số các phần máy chủ đã nhận */
  parts: number[];
};

/** Trạng thái phiên để tải tiếp. Kèm `size`/`fingerprint` của tệp đang chọn thì máy chủ xác nhận đúng tệp (FR-005). */
export async function uploadState(ownerId: string, uploadId: string, chosen: { size?: string | null; fingerprint?: string | null } = {}): Promise<UploadStateDto> {
  const u = await getOwnedUpload(ownerId, uploadId);
  if (u.state !== 'completed' && !isOpen(u)) throw closed();
  if ((chosen.size != null && Number(chosen.size) !== u.sizeBytes) || (chosen.fingerprint != null && chosen.fingerprint !== u.fingerprint)) throw mismatch();
  const parts = await getDb().select({ n: videoUploadParts.n }).from(videoUploadParts).where(eq(videoUploadParts.uploadId, u.id)).orderBy(asc(videoUploadParts.n));
  return { id: u.id, jobId: u.jobId, kind: u.kind, state: u.state, size: u.sizeBytes, partSize: u.partSize, partCount: u.partCount, expiresAt: u.expiresAt.toISOString(), parts: parts.map((p) => p.n) };
}

/** Đọc đúng `expected` byte của thân yêu cầu; thừa hoặc thiếu là lỗi (không tin Content-Length). */
async function readExactly(body: ReadableStream<Uint8Array> | null, expected: number): Promise<Buffer> {
  const wrongSize = () => new HttpError(422, 'UPLOAD_PART_SIZE');
  if (!body) throw wrongSize();
  const out = Buffer.allocUnsafe(expected);
  let got = 0;
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (got + value.length > expected) {
        await reader.cancel().catch(() => undefined);
        throw wrongSize();
      }
      out.set(value, got);
      got += value.length;
    }
  } finally {
    reader.releaseLock();
  }
  if (got !== expected) throw wrongSize();
  return out;
}

export async function receivePart(user: Principal, uploadId: string, partParam: string, request: Request): Promise<void> {
  const upload = await getOwnedUpload(user.id, uploadId);
  requireVideoPermission(user);
  const n = Number(partParam);
  if (!Number.isInteger(n) || n < 1 || n > upload.partCount) throw notFound();
  if (upload.state !== 'active' || !isOpen(upload)) throw closed();
  const expected = n < upload.partCount ? upload.partSize : upload.sizeBytes - upload.partSize * (upload.partCount - 1);
  const declared = request.headers.get('content-length');
  if (declared !== null && Number(declared) !== expected) throw new HttpError(422, 'UPLOAD_PART_SIZE');
  const hash = request.headers.get('x-part-sha256')?.toLowerCase() ?? '';
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new HttpError(422, 'UPLOAD_PART_CHECKSUM');

  if (slots.used >= MAX_PARTS_IN_MEMORY) throw new UploadBusyError();
  slots.used++;
  try {
    const bytes = await readExactly(request.body, expected);
    if (createHash('sha256').update(bytes).digest('hex') !== hash) throw new HttpError(422, 'UPLOAD_PART_CHECKSUM');
    let etag: string;
    try {
      ({ etag } = await uploadPart(upload.key, upload.storageUploadId, n, bytes, request.signal));
    } catch (e) {
      if ((e as Error).name === 'NoSuchUpload') throw closed(); // phiên vừa bị hủy
      throw e;
    }
    await getDb().transaction(async (tx) => {
      const [row] = await tx.select({ state: videoUploads.state }).from(videoUploads).where(eq(videoUploads.id, upload.id)).for('update');
      if (!row || row.state !== 'active') throw closed();
      await tx
        .insert(videoUploadParts)
        .values({ uploadId: upload.id, n, size: expected, etag, sha256: hash })
        .onConflictDoUpdate({ target: [videoUploadParts.uploadId, videoUploadParts.n], set: { size: expected, etag, sha256: hash } });
      await tx
        .update(videoUploads)
        .set({ expiresAt: new Date(Date.now() + UPLOAD_TTL_MS) })
        .where(eq(videoUploads.id, upload.id));
      await tx.update(videoJobs).set({ lastActivityAt: new Date(), updatedAt: new Date() }).where(eq(videoJobs.id, upload.jobId));
      await recomputeSourceExpiry(upload.jobId, tx as unknown as Db);
    });
  } finally {
    slots.used--;
  }
}

/** Mã nhận diện của đối tượng đã ghép, đọc đúng ba đoạn từ kho. */
async function storedFingerprint(key: string, size: number): Promise<string> {
  return fingerprintOf(size, async (start, end) => new Uint8Array(await (await getObjectRange(key, `bytes=${start}-${end - 1}`)).Body!.transformToByteArray()));
}

/**
 * Ghép các phần và chuyển việc sang bước chuẩn bị. Gọi lại nhiều lần an toàn: phiên đã hoàn tất thì chỉ trả lại id việc, dung lượng
 * không bị cộng hai lần.
 */
export async function completeUpload(user: Principal, uploadId: string): Promise<{ jobId: string }> {
  const db = getDb();
  const upload = await getOwnedUpload(user.id, uploadId);
  requireVideoPermission(user);
  if (upload.state === 'completed') return { jobId: upload.jobId };
  if (!isOpen(upload)) throw closed();

  const parts = await db.select().from(videoUploadParts).where(eq(videoUploadParts.uploadId, upload.id)).orderBy(asc(videoUploadParts.n));
  const have = new Set(parts.map((p) => p.n));
  const missing = Array.from({ length: upload.partCount }, (_, i) => i + 1).filter((n) => !have.has(n));
  if (missing.length > 0) throw new HttpError(409, 'UPLOAD_INCOMPLETE', undefined, { missingParts: missing.slice(0, 200).join(',') });

  const claimed = await db
    .update(videoUploads)
    .set({ state: 'completing' })
    .where(and(eq(videoUploads.id, upload.id), inArray(videoUploads.state, ['active', 'completing'])))
    .returning({ id: videoUploads.id });
  if (claimed.length === 0) throw closed();

  try {
    await completeMultipart(upload.key, upload.storageUploadId, parts);
  } catch (e) {
    // lần gọi trước đã ghép xong nhưng chưa kịp ghi CSDL: đối tượng đã đúng dung lượng thì đi tiếp
    if ((await headObject(upload.key))?.size !== upload.sizeBytes) throw e;
  }
  const head = await headObject(upload.key);
  if (!head || head.size !== upload.sizeBytes || (await storedFingerprint(upload.key, upload.sizeBytes)) !== upload.fingerprint) {
    await discardUpload(user.id, upload);
    await deleteObject(upload.key).catch(() => undefined);
    throw mismatch();
  }

  const finished = await withVideoLock(async (tx) => {
    const marked = await tx
      .update(videoUploads)
      .set({ state: 'completed' })
      .where(and(eq(videoUploads.id, upload.id), eq(videoUploads.state, 'completing')))
      .returning({ id: videoUploads.id });
    if (marked.length === 0) return false;
    if (upload.kind === 'source') {
      const [job] = await tx.select({ status: videoJobs.status }).from(videoJobs).where(eq(videoJobs.id, upload.jobId)).for('update');
      await tx
        .update(videoJobs)
        .set({
          sourceKey: upload.key,
          sourceState: 'checking',
          ...(job?.status === 'waiting_media' ? { status: 'queued' as const, stageKey: 'queued' } : {}),
          lastActivityAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(videoJobs.id, upload.jobId));
      await addVideoUsed(user.id, upload.sizeBytes, tx);
    }
    await recomputeSourceExpiry(upload.jobId, tx);
    return true;
  });
  if (finished && upload.kind === 'source') {
    await appendVideoLog(upload.jobId, 'info', 'uploadDone', { mb: Math.round((upload.sizeBytes / 1048576) * 10) / 10 });
    // hàng đợi tạm không nhận được thì sweeper xếp lại (việc đã ở trạng thái chờ)
    await enqueueVideoPrepare(upload.jobId).catch((e) => console.error('[video] không xếp được việc chuẩn bị:', e instanceof Error ? e.message : e));
  }
  return { jobId: upload.jobId };
}

/**
 * Bỏ một phiên tải. Video mới (chưa có kịch bản) thì xóa luôn cả việc; phiên tải LẠI video nguồn (FR-046) thì chỉ đóng phiên và giữ
 * việc cùng kịch bản.
 */
async function discardUpload(ownerId: string, upload: UploadRow): Promise<void> {
  const db = getDb();
  const [job] = await db.select({ cueCount: videoJobs.cueCount, status: videoJobs.status }).from(videoJobs).where(eq(videoJobs.id, upload.jobId));
  if (upload.kind === 'source' && job && job.cueCount === 0 && job.status === 'waiting_media') {
    await deleteVideoJobs(ownerId, { jobIds: [upload.jobId] });
    return;
  }
  await withVideoLock(async (tx) => {
    await tx.update(videoUploads).set({ state: 'aborted' }).where(eq(videoUploads.id, upload.id));
    if (upload.kind === 'source') {
      await tx.update(videoJobs).set({ sourceState: 'deleted', updatedAt: new Date() }).where(eq(videoJobs.id, upload.jobId));
      await recomputeSourceExpiry(upload.jobId, tx);
    }
  });
  await abortMultipart(upload.key, upload.storageUploadId).catch(() => undefined);
}

export async function cancelUpload(ownerId: string, uploadId: string): Promise<void> {
  const upload = await getOwnedUpload(ownerId, uploadId);
  if (upload.state !== 'active' && upload.state !== 'completing') throw closed();
  await discardUpload(ownerId, upload);
}

/** Dọn các phiên quá hạn 48 giờ (sweeper và lịch dọn gọi). Trả id phiên đã đóng. */
export async function expireUpload(upload: UploadRow): Promise<void> {
  await discardUpload(upload.ownerId, upload);
}
