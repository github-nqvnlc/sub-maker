import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  abortMultipart,
  completeMultipart,
  createMultipart,
  ensureBucket,
  getObjectBuffer,
  getObjectRange,
  headObject,
  listMultipartUploads,
  listParts,
  uploadFileMultipart,
  uploadPart,
  deleteByPrefix,
} from '@/lib/storage/client';

/** Tải từng phần lên kho (spec 006, T013; FR-004, research R7, R12). Kho thật (MinIO dev). */
const PREFIX = `users/multipart-${Date.now().toString(36)}/`;
const MB = 1024 * 1024;
let dir: string;

beforeAll(async () => {
  await ensureBucket();
  dir = await mkdtemp(path.join(os.tmpdir(), 'multipart-'));
});
afterAll(async () => {
  await deleteByPrefix(PREFIX);
  await rm(dir, { recursive: true, force: true });
});

const digest = (b: Buffer) => createHash('sha256').update(b).digest('hex');

describe('phiên multipart', () => {
  it('tạo, tải phần, gửi lại phần, liệt kê, ghép thành đúng nội dung', async () => {
    const key = `${PREFIX}a.bin`;
    const parts = [randomBytes(5 * MB), randomBytes(5 * MB), randomBytes(1234)];
    const id = await createMultipart(key, 'video/mp4');
    expect(await listMultipartUploads(key)).toContain(id);
    // gửi phần 2 hai lần: lần sau thắng
    await uploadPart(key, id, 2, randomBytes(5 * MB));
    const etags = [];
    for (let n = 1; n <= parts.length; n++) etags.push({ n, etag: (await uploadPart(key, id, n, parts[n - 1]!)).etag });
    const listed = await listParts(key, id);
    expect(listed.map((p) => [p.n, p.size, p.etag])).toEqual(etags.map((e, i) => [e.n, parts[i]!.length, e.etag]));
    await completeMultipart(key, id, [...etags].reverse()); // thứ tự gửi không quan trọng
    expect((await headObject(key))?.size).toBe(10 * MB + 1234);
    expect(digest(await getObjectBuffer(key))).toBe(digest(Buffer.concat(parts)));
    expect(await listMultipartUploads(key)).toEqual([]);
  });

  it('hủy: không còn phiên, không có đối tượng, gọi lại không lỗi', async () => {
    const key = `${PREFIX}b.bin`;
    const id = await createMultipart(key);
    await uploadPart(key, id, 1, randomBytes(1000));
    await abortMultipart(key, id);
    await expect(abortMultipart(key, id)).resolves.toBeUndefined();
    expect(await listMultipartUploads(key)).toEqual([]);
    expect(await headObject(key)).toBeNull();
    await expect(uploadPart(key, id, 2, randomBytes(10))).rejects.toThrow();
  });
});

describe('tải tệp trên đĩa theo multipart', () => {
  it.each([
    ['nhiều phần', 12 * MB + 77],
    ['vừa đúng bội số', 10 * MB],
    ['nhỏ hơn một phần', 4321],
  ])('%s', async (_name, size) => {
    const file = path.join(dir, `f-${size}`);
    const body = randomBytes(size);
    await writeFile(file, body);
    const key = `${PREFIX}file-${size}.bin`;
    expect(await uploadFileMultipart(key, file, 'video/mp4', { partSize: 5 * MB })).toEqual({ size });
    expect(digest(await getObjectBuffer(key))).toBe(digest(body));
    expect((await headObject(key))?.contentType).toBe('video/mp4');
    expect(await listMultipartUploads(key)).toEqual([]);
  });

  it('bị hủy giữa chừng: ném lỗi, không để lại phiên hay đối tượng', async () => {
    const file = path.join(dir, 'abort');
    await writeFile(file, randomBytes(16 * MB));
    const key = `${PREFIX}abort.bin`;
    const controller = new AbortController();
    const upload = uploadFileMultipart(key, file, 'video/mp4', { partSize: 5 * MB, signal: controller.signal, onProgress: () => controller.abort() });
    await expect(upload).rejects.toThrow();
    expect(await headObject(key)).toBeNull();
    expect(await listMultipartUploads(key)).toEqual([]);
  });

  it('tệp rỗng bị từ chối', async () => {
    const file = path.join(dir, 'empty');
    await writeFile(file, '');
    await expect(uploadFileMultipart(`${PREFIX}empty.bin`, file, 'video/mp4')).rejects.toThrow();
  });
});

describe('đọc dải có hủy', () => {
  it('trả đúng dải; hủy thì lệnh đọc dừng', async () => {
    const key = `${PREFIX}range.bin`;
    const file = path.join(dir, 'range');
    const body = randomBytes(6 * MB);
    await writeFile(file, body);
    await uploadFileMultipart(key, file, 'application/octet-stream', { partSize: 5 * MB });
    const part = await getObjectRange(key, 'bytes=100-199');
    expect(Buffer.from(await part.Body!.transformToByteArray()).equals(body.subarray(100, 200))).toBe(true);

    const early = new AbortController();
    early.abort();
    await expect(getObjectRange(key, 'bytes=0-9', early.signal)).rejects.toThrow();

    const mid = new AbortController();
    const res = await getObjectRange(key, undefined, mid.signal);
    const reader = res.Body!.transformToWebStream().getReader();
    await reader.read();
    mid.abort();
    await expect(
      (async () => {
        for (;;) if ((await reader.read()).done) return 'done';
      })(),
    ).rejects.toThrow();
  });
});
