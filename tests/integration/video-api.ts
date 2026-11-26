import { createHash } from 'node:crypto';
import { PUT as putPartRoute } from '@/app/api/video/uploads/[uploadId]/parts/[n]/route';
import { fingerprintOf } from '@/lib/video/fingerprint';
import type { VideoJobDto } from '@/lib/video/service';
import type { TestUser } from './helpers';

/** Gọi API tải video trong kiểm thử (spec 006). */
export const MB = 1024 * 1024;
export const PART = 16 * MB;

export const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
export const videoFingerprint = (bytes: Buffer) => fingerprintOf(bytes.length, async (a, b) => bytes.subarray(a, b));

export const postVideoJob = (user: TestUser, projectId: string, json: unknown) => user.client.post(`/api/projects/${projectId}/video/jobs`, { json });

export type CreatedVideo = { job: VideoJobDto; upload: { id: string; partSize: number; partCount: number } };

export async function createVideoJobApi(user: TestUser, projectId: string, bytes: Buffer, over: Record<string, unknown> = {}): Promise<CreatedVideo> {
  const res = await postVideoJob(user, projectId, { fileName: 'phim.mp4', size: bytes.length, fingerprint: await videoFingerprint(bytes), direction: 'to_vi', ...over });
  if (res.status !== 201) throw new Error(`createVideoJob: ${res.status} ${await res.text()}`);
  return (await res.json()) as CreatedVideo;
}

/** Gửi một phần với thân thô. `stream` thay thân để mô phỏng đường truyền chậm. */
export async function putPart(user: TestUser, uploadId: string, n: number, bytes: Uint8Array, opts: { hash?: string; stream?: ReadableStream<Uint8Array> } = {}): Promise<Response> {
  const url = `http://localhost:3000/api/video/uploads/${uploadId}/parts/${n}`;
  const headers: Record<string, string> = {
    origin: 'http://localhost:3000',
    cookie: user.client.cookieHeader(),
    'content-type': 'application/octet-stream',
    'content-length': String(bytes.length),
    'x-part-sha256': opts.hash ?? sha256(bytes),
  };
  const init: RequestInit & { duplex?: 'half' } = { method: 'PUT', headers, body: opts.stream ?? new Uint8Array(bytes), duplex: 'half' };
  return putPartRoute(new Request(url, init), { params: Promise.resolve({ uploadId, n: String(n) }) });
}

export async function uploadAll(user: TestUser, upload: CreatedVideo['upload'], bytes: Buffer): Promise<void> {
  for (let n = 1; n <= upload.partCount; n++) {
    const res = await putPart(user, upload.id, n, bytes.subarray((n - 1) * upload.partSize, n * upload.partSize));
    if (res.status !== 204) throw new Error(`putPart ${n}: ${res.status} ${await res.text()}`);
  }
}

/** Tải lên trọn video qua API; việc chuyển sang hàng đợi chuẩn bị. */
export async function uploadVideo(user: TestUser, projectId: string, bytes: Buffer, over: Record<string, unknown> = {}): Promise<VideoJobDto> {
  const { upload } = await createVideoJobApi(user, projectId, bytes, over);
  await uploadAll(user, upload, bytes);
  const done = await user.client.post(`/api/video/uploads/${upload.id}/complete`);
  if (done.status !== 200) throw new Error(`complete: ${done.status} ${await done.text()}`);
  return (await done.json()) as VideoJobDto;
}
