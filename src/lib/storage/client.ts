import {
  CreateBucketCommand,
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

export async function getObjectRange(key: string, range?: string): Promise<GetObjectCommandOutput> {
  return s3().send(new GetObjectCommand({ Bucket: bucket(), Key: key, Range: range }));
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
