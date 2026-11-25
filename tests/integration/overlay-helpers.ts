import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { asc, eq, sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { overlayJobLogs, overlayJobs, projects, users, voiceJobs, voices, type TimelineEntry } from '@/lib/db/schema';
import { DEFAULT_CONFIG, type OverlayConfig } from '@/lib/overlay/config';
import { getObjectBuffer, listKeys, putObject } from '@/lib/storage/client';
import { storageKeys } from '@/lib/storage/keys';
import type { TestUser } from './helpers';
import { uploadScript } from './voice-helpers';

/** Hàm dùng chung cho kiểm thử video overlay (spec 005). Dữ liệu ≤ 10 giây, không gọi nhà cung cấp AI. */

const fixture = (name: string) => readFile(path.resolve(process.cwd(), 'tests/fixtures', name));
export const SRT_10S = () => fixture('sample-10s.srt').then((b) => b.toString('utf8'));
export const VOICE_MS = 10_000;

export const overlayConfig = (over: Partial<OverlayConfig> = {}): OverlayConfig => ({ ...structuredClone(DEFAULT_CONFIG), ...over });

/** Tải tệp .srt mẫu vào Project (qua API thật), trả id. */
export async function uploadSrt(user: TestUser, projectId: string, text?: string, name = 'mau.srt'): Promise<string> {
  return (await uploadScript(user, projectId, text ?? (await SRT_10S()), name)).id;
}

const CUE_TEXTS = ['Bạn đã nghe hai bài phát biểu ở Thẩm Quyến ngày 18 tháng 11.', 'Nhưng Tập Cận Bình không nhắc đến Nga một lần nào.', 'Không Putin.'];

/** Timeline của voice khớp mốc cho tệp mẫu: trễ 100 ms so với mốc tệp. */
export const TIMED_TIMELINE: TimelineEntry[] = [
  { idx: 0, startMs: 400, endMs: 4500, text: CUE_TEXTS[0], slipMs: 100 },
  { idx: 1, startMs: 5105, endMs: 8400, text: CUE_TEXTS[1], slipMs: 100 },
  { idx: 2, startMs: 8872, endMs: 9700, text: CUE_TEXTS[2], slipMs: 100 },
];
/** Như trên nhưng câu đầu bị tách làm hai đơn vị và câu thứ hai bị nhà cung cấp từ chối. */
export const SPLIT_FAILED_TIMELINE: TimelineEntry[] = [
  { idx: 0, startMs: 400, endMs: 2000, text: 'Bạn đã nghe hai bài phát biểu' },
  { idx: 1, startMs: 2100, endMs: 4500, text: 'ở Thẩm Quyến ngày 18 tháng 11.' },
  { idx: 2, startMs: 5005, endMs: 8442, text: CUE_TEXTS[1], failed: true },
  { idx: 3, startMs: 8872, endMs: 9700, text: CUE_TEXTS[2] },
];

/** Ghi thẳng một voice đã hoàn tất (job + voice + đối tượng MP3 + dung lượng), không gọi nhà cung cấp. */
export async function makeVoice(
  user: TestUser,
  projectId: string,
  fileId: string,
  opts: { timed?: boolean; timeline?: TimelineEntry[]; title?: string } = {},
): Promise<{ voiceId: string; voiceJobId: string }> {
  const timed = opts.timed ?? true;
  const db = getDb();
  const voiceId = randomUUID();
  const voiceJobId = randomUUID();
  const mp3 = await fixture('sample-10s.mp3');
  const key = storageKeys.voice(user.id, voiceId);
  await putObject(key, mp3, 'audio/mpeg');
  await db.insert(voiceJobs).values({
    id: voiceJobId,
    projectId,
    ownerId: user.id,
    subtitleFileId: fileId,
    status: 'completed',
    providerType: 'fpt_marketplace',
    configScope: 'global',
    settings: {
      voice: 'banmai',
      ...(timed ? { timing: { mode: 'timed', mergeCues: true, params: { maxSlipMs: 500, maxCompressPct: 125, mergeGapMs: 1000, partMinutes: 10 } } } : {}),
    },
  });
  await db.insert(voices).values({
    id: voiceId,
    projectId,
    ownerId: user.id,
    jobId: voiceJobId,
    subtitleFileId: fileId,
    title: opts.title ?? 'Voice mẫu',
    storageKey: key,
    durationMs: VOICE_MS,
    sizeBytes: mp3.length,
    timeline: opts.timeline ?? TIMED_TIMELINE,
  });
  await db.update(users).set({ storageUsedBytes: sql`${users.storageUsedBytes} + ${mp3.length}` }).where(eq(users.id, user.id));
  await db.update(projects).set({ voiceCount: sql`${projects.voiceCount} + 1` }).where(eq(projects.id, projectId));
  return { voiceId, voiceJobId };
}

export type OverlayJobDto = {
  id: string;
  status: string;
  progressPercent: number;
  errorCode: string | null;
  sizeBytes: number | null;
  estimatedBytes: number;
  canRerun: boolean;
  warnings: Array<{ code: string }>;
  config: OverlayConfig;
  format: string;
};

export function postOverlayJob(
  user: TestUser,
  projectId: string,
  body: { fileId: string; voiceId?: string; audioId?: string; config?: OverlayConfig; clientRequestId?: string },
): Promise<Response> {
  return user.client.post(`/api/projects/${projectId}/overlay/jobs`, {
    json: { clientRequestId: body.clientRequestId ?? randomUUID(), fileId: body.fileId, voiceId: body.voiceId, audioId: body.audioId, config: body.config ?? overlayConfig() },
  });
}

export async function createOverlayJob(user: TestUser, projectId: string, body: Parameters<typeof postOverlayJob>[2]): Promise<OverlayJobDto> {
  const res = await postOverlayJob(user, projectId, body);
  if (res.status !== 201) throw new Error(`createOverlayJob: ${res.status} ${await res.text()}`);
  return (await res.json()) as OverlayJobDto;
}

export const overlayRow = async (id: string) => (await getDb().select().from(overlayJobs).where(eq(overlayJobs.id, id)))[0];
export const overlayLogKeys = async (id: string) =>
  (await getDb().select().from(overlayJobLogs).where(eq(overlayJobLogs.jobId, id)).orderBy(asc(overlayJobLogs.id))).map((l) => l.messageKey);
export const usedBytes = async (userId: string) => (await getDb().select({ u: users.storageUsedBytes }).from(users).where(eq(users.id, userId)))[0]!.u;

/** Mọi khóa đối tượng của User có chứa chuỗi con. */
export async function keysOf(userId: string, part = ''): Promise<string[]> {
  const out: string[] = [];
  for await (const { key } of listKeys(storageKeys.userPrefix(userId))) if (key.includes(part)) out.push(key);
  return out;
}

// ---- Đọc video bằng ffmpeg/ffprobe ---------------------------------------------------------------

function run(cmd: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.stderr.on('data', (c: Buffer) => err.push(c));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`${cmd} ${code}: ${Buffer.concat(err).toString('utf8').slice(0, 400)}`))));
  });
}

/** Tải video thành phẩm của một job về tệp tạm rồi chạy `fn`. */
export async function withVideo<T>(jobId: string, fn: (file: string) => Promise<T>): Promise<T> {
  const row = await overlayRow(jobId);
  if (!row?.outputStorageKey) throw new Error(`Job ${jobId} chưa có video (${row?.status} ${row?.errorCode})`);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'overlay-test-'));
  try {
    const file = path.join(dir, `v.${row.format}`);
    await writeFile(file, await getObjectBuffer(row.outputStorageKey));
    return await fn(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export type VideoInfo = { width: number; height: number; fps: number; frames: number; durationMs: number; codec: string; pixFmt: string; audio: string | null };

export async function probeVideo(file: string): Promise<VideoInfo> {
  const j = JSON.parse(
    (
      await run('ffprobe', ['-v', 'error', '-count_frames', '-show_entries', 'stream=codec_type,codec_name,width,height,r_frame_rate,nb_read_frames,pix_fmt:format=duration', '-of', 'json', file])
    ).toString('utf8'),
  ) as { streams: Array<Record<string, string | number>>; format: { duration: string } };
  const v = j.streams.find((s) => s.codec_type === 'video')!;
  const a = j.streams.find((s) => s.codec_type === 'audio');
  const [n, d] = String(v.r_frame_rate).split('/').map(Number);
  return {
    width: Number(v.width),
    height: Number(v.height),
    fps: n! / d!,
    frames: Number(v.nb_read_frames),
    durationMs: Number(j.format.duration) * 1000,
    codec: String(v.codec_name),
    pixFmt: String(v.pix_fmt),
    audio: a ? String(a.codec_name) : null,
  };
}

/** Điểm ảnh RGBA của khung thứ `frame` (0-based). VP9 phải giải mã bằng libvpx mới có kênh alpha. */
export async function frameAt(file: string, frame: number, info: { width: number; height: number }): Promise<Buffer> {
  const isWebm = file.endsWith('.webm');
  const isMp4 = file.endsWith('.mp4');
  return run('ffmpeg', [
    '-v', 'error',
    ...(isWebm ? ['-c:v', 'libvpx-vp9'] : []),
    '-i', file,
    '-vf', `select=eq(n\\,${frame})${isMp4 ? ',scale=in_color_matrix=bt709:in_range=tv' : ''},format=rgba`,
    '-frames:v', '1', '-fps_mode', 'passthrough',
    '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${info.width}x${info.height}`, 'pipe:1',
  ]);
}

/** Số điểm ảnh gần trắng trong khung (chữ mặc định màu trắng). */
export function whitePixels(rgba: Buffer): number {
  let n = 0;
  for (let o = 0; o < rgba.length; o += 4) if (rgba[o]! > 200 && rgba[o + 1]! > 200 && rgba[o + 2]! > 200 && rgba[o + 3]! > 200) n++;
  return n;
}

export const px = (rgba: Buffer, width: number, x: number, y: number): number[] => {
  const o = (y * width + x) * 4;
  return [...rgba.subarray(o, o + 4)];
};
