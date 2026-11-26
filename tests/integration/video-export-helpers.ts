import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { videoExports } from '@/lib/db/schema';
import type { VideoExportDto } from '@/lib/video/service';
import { downloadObjectToFile } from '@/lib/storage/client';
import { runVideoRender, type VideoRenderOptions } from '@/worker/jobs/video-render';
import type { BurnTask } from '@/worker/render/protocol';
import type { RenderOutcome, SpawnRender } from '@/worker/render/spawn-render';
import type { TestUser } from './helpers';
import { videoJobRow } from './video-helpers';
import { runPipeline, uploadedJob } from './video-pipeline-helpers';
import type { TestVideoOptions } from './video-media';

/** Hàm dùng chung cho kiểm thử xuất video (spec 006, US3). */

const SHORT = { maxAttempts: 4, baseMs: 5, maxMs: 20 };
export const FAST_EXPORT: VideoRenderOptions = { retry: SHORT, heartbeatMs: 100, admissionPollMs: 20, stallMs: 60_000 };

/** Việc đã dịch xong, chờ duyệt. */
export async function reviewJob(user: TestUser, projectId: string, video?: TestVideoOptions | Buffer, fileName?: string) {
  const job = await uploadedJob(user, projectId, { video, fileName });
  await runPipeline(job.id);
  const row = (await videoJobRow(job.id))!;
  if (row.status !== 'review_ready') throw new Error(`việc ở trạng thái ${row.status} ${row.errorCode ?? ''}`);
  return row;
}

export const postExport = async (user: TestUser, jobId: string, over: Record<string, unknown> = {}) => {
  const row = await videoJobRow(jobId);
  return user.client.post(`/api/video/jobs/${jobId}/exports`, { json: { kind: 'burn', format: 'mp4', baseRevision: row?.cueRevision ?? 0, ...over } });
};

export async function createExportApi(user: TestUser, jobId: string): Promise<VideoExportDto> {
  const res = await postExport(user, jobId);
  if (res.status !== 201) throw new Error(`createExport: ${res.status} ${await res.text()}`);
  return (await res.json()) as VideoExportDto;
}

export const runExport = (exportId: string, over: VideoRenderOptions = {}) => runVideoRender(exportId, { ...FAST_EXPORT, ...over });
export const exportRow = async (id: string) => (await getDb().select().from(videoExports).where(eq(videoExports.id, id)))[0];

/**
 * Tiến trình con giả: ghi tệp `bytes` byte rồi báo xong (hoặc báo lỗi theo `outcomes`). `hold` giữ lượt dựng tới khi gọi `release` hoặc
 * bị hủy.
 */
export function fakeBurn(opts: { bytes?: number; outcomes?: Array<'ok' | Exclude<RenderOutcome, { ok: true }>['code']>; hold?: boolean } = {}) {
  const tasks: BurnTask[] = [];
  let release = () => {};
  const gate = opts.hold ? new Promise<void>((r) => (release = r)) : Promise.resolve();
  let cancelled = 0;
  const spawn: SpawnRender<BurnTask> = (task, hooks) => {
    tasks.push(task);
    let cancel = () => {};
    const stopped = new Promise<RenderOutcome>((resolve) => {
      cancel = () => {
        cancelled++;
        resolve({ ok: false, code: 'CANCELLED', detail: '' });
      };
    });
    const work = (async (): Promise<RenderOutcome> => {
      hooks.onProgress?.(1, 10);
      await gate;
      const outcome = opts.outcomes?.[tasks.length - 1] ?? 'ok';
      if (outcome !== 'ok') return { ok: false, code: outcome, detail: 'giả lập' };
      const bytes = opts.bytes ?? 4096;
      if (bytes > task.maxBytes) return { ok: false, code: 'QUOTA_EXCEEDED', detail: '' };
      await writeFile(task.outPath, Buffer.alloc(bytes, 1));
      return { ok: true, bytes };
    })();
    return { done: Promise.race([work, stopped]), cancel: () => cancel(), pid: undefined };
  };
  return { spawn, tasks, release: () => release(), cancelled: () => cancelled };
}

/** Chờ tới khi điều kiện đúng (tối đa 15 giây). */
export async function until(check: () => unknown | Promise<unknown>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('quá thời gian chờ');
    await new Promise((r) => setTimeout(r, 20));
  }
}

// ---- Đo thành phẩm --------------------------------------------------------------------------------

const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';

export async function withObject<T>(key: string, fn: (file: string, dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ex-'));
  try {
    const file = path.join(dir, 'out.mp4');
    await downloadObjectToFile(key, file);
    return await fn(file, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export type Probe = {
  format: { duration: string };
  streams: Array<{ codec_type: string; codec_name: string; width?: number; height?: number; pix_fmt?: string; nb_read_packets?: string; color_transfer?: string; color_space?: string; side_data_list?: Array<{ rotation?: number }> }>;
};
export function probeFile(file: string): Probe {
  return JSON.parse(execFileSync(FFPROBE, ['-v', 'error', '-count_packets', '-show_format', '-show_streams', '-of', 'json', file], { encoding: 'utf8' })) as Probe;
}
export const videoStreamOf = (p: Probe) => p.streams.find((s) => s.codec_type === 'video')!;
export const audioStreamOf = (p: Probe) => p.streams.find((s) => s.codec_type === 'audio')!;

/** Mã băm của luồng tiếng chép nguyên: hai tệp trùng nghĩa là tiếng không bị mã hóa lại. */
export const audioHash = (file: string): string => execFileSync(FFMPEG, ['-v', 'error', '-i', file, '-map', '0:a:0', '-c', 'copy', '-f', 'md5', '-'], { encoding: 'utf8' }).trim();

/** Một khung tại `seconds` dưới dạng điểm ảnh xám. */
export function grayFrame(file: string, seconds: number, width: number, height: number): Buffer {
  return execFileSync(FFMPEG, ['-v', 'error', '-ss', String(seconds), '-i', file, '-frames:v', '1', '-vf', `scale=${width}:${height},format=gray`, '-f', 'rawvideo', '-'], { maxBuffer: 64 * 1024 * 1024 });
}

/** Độ lệch trung bình giữa hai vùng hàng [from, to) của hai khung. */
export function rowsDiff(a: Buffer, b: Buffer, width: number, from: number, to: number): number {
  let sum = 0;
  for (let i = from * width; i < to * width; i++) sum += Math.abs(a[i]! - b[i]!);
  return sum / Math.max(1, (to - from) * width);
}

/** Các mốc (giây) mà khung đầu tiên của một chớp sáng xuất hiện. */
export function flashTimes(file: string): number[] {
  const log = execFileSync(FFMPEG, ['-v', 'error', '-i', file, '-map', '0:v:0', '-vf', 'crop=64:64:0:0,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-', '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const times: number[] = [];
  let time = 0;
  let lit = false;
  for (const line of log.split('\n')) {
    const t = /pts_time:([\d.]+)/.exec(line);
    if (t) time = Number(t[1]);
    const y = /YAVG=([\d.]+)/.exec(line);
    if (!y) continue;
    const now = Number(y[1]) > 150;
    if (now && !lit) times.push(time);
    lit = now;
  }
  return times;
}

/** Các mốc (giây) mà tiếng bíp bắt đầu. */
export function beepTimes(file: string): number[] {
  const dir = execFileSync(FFMPEG, ['-v', 'error', '-i', file, '-map', '0:a:0', '-ac', '1', '-ar', '8000', '-f', 's16le', '-'], { maxBuffer: 64 * 1024 * 1024 });
  const times: number[] = [];
  let loud = false;
  const win = 40; // 5 ms
  for (let i = 0; i + win <= dir.length / 2; i += win) {
    let peak = 0;
    for (let j = i; j < i + win; j++) peak = Math.max(peak, Math.abs(dir.readInt16LE(j * 2)));
    const now = peak > 3000;
    if (now && !loud) times.push(i / 8000);
    loud = now;
  }
  return times;
}
