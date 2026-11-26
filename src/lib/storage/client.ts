import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  ListMultipartUploadsCommand,
  ListPartsCommand,
  UploadPartCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutBucketPolicyCommand,
  PutObjectCommand,
  S3Client,
  type GetObjectCommandOutput,
} from '@aws-sdk/client-s3';
import { env } from '../env';

type Holder = { client?: S3Client; key?: string; ready?: Promise<void> };
const g = globalThis as unknown as { __submakerS3?: Holder };
const holder: Holder = (g.__submakerS3 ??= {});

function configKey() {
  const e = env();
  return `${e.S3_ENDPOINT}|${e.S3_BUCKET}|${e.S3_ACCESS_KEY}`;
}

export function s3(): S3Client {
  const k = configKey();
  if (!holder.client || holder.key !== k) {
    const e = env();
    holder.client = new S3Client({
      endpoint: e.S3_ENDPOINT,
      region: e.S3_REGION,
      forcePathStyle: true,
      credentials: { accessKeyId: e.S3_ACCESS_KEY, secretAccessKey: e.S3_SECRET_KEY },
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
    holder.key = k;
    holder.ready = undefined;
  }
  return holder.client;
}

export const bucket = () => env().S3_BUCKET;

/** Tạo bucket riêng tư nếu chưa có (gọi lúc khởi động web/worker và trong kiểm thử). */
export async function ensureBucket(): Promise<void> {
  const client = s3();
  holder.ready ??= (async () => {
    try {
      await client.send(new HeadBucketCommand({ Bucket: bucket() }));
    } catch {
      await client.send(new CreateBucketCommand({ Bucket: bucket() }));
    }
    // Bảo đảm không có chính sách công khai: policy rỗng không được hỗ trợ trên mọi triển khai, nên bỏ qua lỗi.
    try {
      await client.send(
        new PutBucketPolicyCommand({
          Bucket: bucket(),
          Policy: JSON.stringify({ Version: '2012-10-17', Statement: [] }),
        }),
      );
    } catch {
      /* bucket mới tạo mặc định là riêng tư */
    }
  })();
  try {
    await holder.ready;
  } catch (e) {
    holder.ready = undefined;
    throw e;
  }
}

export async function putObject(
  key: string,
  body: Buffer | Uint8Array | string,
  contentType = 'application/octet-stream',
): Promise<void> {
  await s3().send(new PutObjectCommand({ Bucket: bucket(), Key: key, Body: body, ContentType: contentType }));
}

export async function getObjectBuffer(key: string): Promise<Buffer> {
  const res = await s3().send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
  const bytes = await res.Body!.transformToByteArray();
  return Buffer.from(bytes);
}

/** Đọc đối tượng (hoặc một dải). `signal` hủy cả yêu cầu lẫn luồng thân đang đọc (trình duyệt ngắt thì kho cũng ngừng gửi). */
export async function getObjectRange(key: string, range?: string, signal?: AbortSignal): Promise<GetObjectCommandOutput> {
  signal?.throwIfAborted();
  const res = await s3().send(new GetObjectCommand({ Bucket: bucket(), Key: key, Range: range }), { abortSignal: signal });
  if (signal && res.Body) {
    const body = res.Body as unknown as import('node:stream').Readable;
    const stop = () => body.destroy(new Error('aborted'));
    signal.addEventListener('abort', stop, { once: true });
    body.once?.('close', () => signal.removeEventListener('abort', stop));
  }
  return res;
}

export async function headObject(key: string): Promise<{ size: number; contentType?: string } | null> {
  try {
    const res = await s3().send(new HeadObjectCommand({ Bucket: bucket(), Key: key }));
    return { size: res.ContentLength ?? 0, contentType: res.ContentType };
  } catch (e) {
    const status = (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (status === 404) return null;
    throw e;
  }
}

export async function deleteObject(key: string): Promise<void> {
  await s3().send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
}

/** Liệt kê khóa theo tiền tố (phân trang). */
export async function* listKeys(prefix: string): AsyncGenerator<{ key: string; size: number }> {
  let token: string | undefined;
  do {
    const res = await s3().send(new ListObjectsV2Command({ Bucket: bucket(), Prefix: prefix, ContinuationToken: token }));
    for (const o of res.Contents ?? []) if (o.Key) yield { key: o.Key, size: o.Size ?? 0 };
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
}

/** Xóa mọi đối tượng theo tiền tố, trả số đối tượng đã xóa. Idempotent. */
export async function deleteByPrefix(prefix: string): Promise<number> {
  if (!prefix.endsWith('/') || prefix.length < 3) throw new Error('Tiền tố xóa không an toàn');
  let deleted = 0;
  let batch: { Key: string }[] = [];
  const flush = async () => {
    if (batch.length === 0) return;
    const res = await s3().send(
      new DeleteObjectsCommand({ Bucket: bucket(), Delete: { Objects: batch, Quiet: true } }),
    );
    if (res.Errors && res.Errors.length > 0) {
      throw new Error(`Xóa đối tượng thất bại: ${res.Errors[0]?.Code ?? 'unknown'}`);
    }
    deleted += batch.length;
    batch = [];
  };
  for await (const { key } of listKeys(prefix)) {
    batch.push({ Key: key });
    if (batch.length >= 1000) await flush();
  }
  await flush();
  return deleted;
}

/** Tổng dung lượng các đối tượng theo tiền tố (dùng đối soát quota). */
export async function sizeByPrefix(prefix: string): Promise<number> {
  let total = 0;
  for await (const { size } of listKeys(prefix)) total += size;
  return total;
}

/** Ghi đối tượng từ luồng (tệp lớn như media STT — spec 004) mà không giữ toàn bộ trong bộ nhớ. */
export async function putObjectStream(
  key: string,
  body: ReadableStream<Uint8Array> | NodeJS.ReadableStream,
  contentLength: number,
  contentType = 'application/octet-stream',
): Promise<void> {
  const { Readable, Transform } = await import('node:stream');
  const baseStream = 'getReader' in body ? Readable.fromWeb(body as import('node:stream/web').ReadableStream<Uint8Array>) : body;
  // Giới hạn chunk <= 8 MiB để tương thích MinIO SigV4 streaming (MinIO từ chối chunk > 16 MiB)
  const maxChunk = 8 * 1024 * 1024;
  const chunkLimiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      if (chunk.length <= maxChunk) {
        this.push(chunk);
      } else {
        for (let i = 0; i < chunk.length; i += maxChunk) {
          this.push(chunk.subarray(i, Math.min(i + maxChunk, chunk.length)));
        }
      }
      callback();
    },
  });
  const stream = (baseStream as NodeJS.ReadableStream).pipe(chunkLimiter);
  await s3().send(new PutObjectCommand({ Bucket: bucket(), Key: key, Body: stream as never, ContentLength: contentLength, ContentType: contentType }));
}

/** Tải đối tượng về tệp trên đĩa theo luồng. */
export async function downloadObjectToFile(key: string, filePath: string): Promise<void> {
  const { createWriteStream } = await import('node:fs');
  const { pipeline } = await import('node:stream/promises');
  const res = await s3().send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
  await pipeline(res.Body as NodeJS.ReadableStream, createWriteStream(filePath));
}

// ---- Multipart (spec 006: video lớn) ------------------------------------------------------------

export async function createMultipart(key: string, contentType = 'application/octet-stream'): Promise<string> {
  const res = await s3().send(new CreateMultipartUploadCommand({ Bucket: bucket(), Key: key, ContentType: contentType }));
  return res.UploadId!;
}

/** Gửi một phần (1…10.000); gửi lại cùng số thì phần mới thay phần cũ. Mọi phần trừ phần cuối phải từ 5 MB. */
export async function uploadPart(key: string, uploadId: string, n: number, body: Buffer, signal?: AbortSignal): Promise<{ etag: string }> {
  const res = await s3().send(new UploadPartCommand({ Bucket: bucket(), Key: key, UploadId: uploadId, PartNumber: n, Body: body, ContentLength: body.length }), { abortSignal: signal });
  return { etag: res.ETag! };
}

export async function listParts(key: string, uploadId: string): Promise<Array<{ n: number; etag: string; size: number }>> {
  const out: Array<{ n: number; etag: string; size: number }> = [];
  let marker: string | undefined;
  do {
    const res = await s3().send(new ListPartsCommand({ Bucket: bucket(), Key: key, UploadId: uploadId, PartNumberMarker: marker }));
    for (const p of res.Parts ?? []) out.push({ n: p.PartNumber!, etag: p.ETag!, size: p.Size ?? 0 });
    marker = res.IsTruncated ? res.NextPartNumberMarker : undefined;
  } while (marker);
  return out;
}

export async function completeMultipart(key: string, uploadId: string, parts: ReadonlyArray<{ n: number; etag: string }>): Promise<void> {
  const Parts = [...parts].sort((a, b) => a.n - b.n).map((p) => ({ PartNumber: p.n, ETag: p.etag }));
  await s3().send(new CompleteMultipartUploadCommand({ Bucket: bucket(), Key: key, UploadId: uploadId, MultipartUpload: { Parts } }));
}

/** Hủy phiên và giải phóng các phần đã gửi. Phiên không còn thì coi như xong. */
export async function abortMultipart(key: string, uploadId: string): Promise<void> {
  try {
    await s3().send(new AbortMultipartUploadCommand({ Bucket: bucket(), Key: key, UploadId: uploadId }));
  } catch (e) {
    const err = e as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (err.name !== 'NoSuchUpload' && err.$metadata?.httpStatusCode !== 404) throw e;
  }
}

/** Id các phiên multipart còn mở của ĐÚNG khóa này (MinIO chỉ liệt kê theo khóa đầy đủ). */
export async function listMultipartUploads(key: string): Promise<string[]> {
  const res = await s3().send(new ListMultipartUploadsCommand({ Bucket: bucket(), Prefix: key }));
  return (res.Uploads ?? []).filter((u) => u.Key === key).map((u) => u.UploadId!);
}

/** Kích thước phần khi worker tải thành phẩm lên: 64 MB × 10.000 phần đủ cho mọi video của hạn mức. */
export const FILE_PART_SIZE = 64 * 1024 * 1024;

/** Tải một tệp trên đĩa lên kho theo multipart (thành phẩm có thể lớn hơn giới hạn 5 GB của một lần ghi). */
export async function uploadFileMultipart(
  key: string,
  filePath: string,
  contentType = 'application/octet-stream',
  opts: { partSize?: number; signal?: AbortSignal; onProgress?: (sent: number, total: number) => void } = {},
): Promise<{ size: number }> {
  const { open } = await import('node:fs/promises');
  const partSize = opts.partSize ?? FILE_PART_SIZE;
  const file = await open(filePath, 'r');
  try {
    const { size } = await file.stat();
    if (size <= 0) throw new Error('Tệp rỗng, không tải lên');
    const uploadId = await createMultipart(key, contentType);
    try {
      const parts: Array<{ n: number; etag: string }> = [];
      const buffer = Buffer.allocUnsafe(Math.min(partSize, size));
      let sent = 0;
      for (let n = 1; sent < size; n++) {
        const want = Math.min(partSize, size - sent);
        let got = 0;
        while (got < want) {
          const { bytesRead } = await file.read(buffer, got, want - got, sent + got);
          if (bytesRead === 0) throw new Error('Tệp bị cắt trong lúc tải lên');
          got += bytesRead;
        }
        opts.signal?.throwIfAborted();
        parts.push({ n, etag: (await uploadPart(key, uploadId, n, buffer.subarray(0, want), opts.signal)).etag });
        sent += want;
        opts.onProgress?.(sent, size);
      }
      opts.signal?.throwIfAborted();
      await completeMultipart(key, uploadId, parts);
      return { size };
    } catch (e) {
      await abortMultipart(key, uploadId).catch(() => undefined);
      throw e;
    }
  } finally {
    await file.close();
  }
}
