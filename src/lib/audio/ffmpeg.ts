import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Giải mã/mã hóa audio bằng ffmpeg (có sẵn trong ảnh worker). PCM chuẩn của hệ thống:
 * 24 kHz, mono, 16-bit little-endian — mọi đoạn đều được đưa về dạng này trước khi ghép nên không bị
 * "lách tách" do khác tần số/kênh (docs/fpt-ai-voice-guide.md §10).
 */
import type { VideoMedia } from '../video/types';
import { BYTES_PER_SAMPLE, SAMPLE_RATE } from './pcm';
export { BYTES_PER_SAMPLE, SAMPLE_RATE };

const FFMPEG = () => process.env.FFMPEG_PATH || 'ffmpeg';

export function runFfmpeg(args: string[], input: Buffer | Uint8Array | null, timeoutMs = 120_000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG(), ['-hide_banner', '-loglevel', 'error', '-nostdin', ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      done(() => reject(new Error('ffmpeg quá thời gian')));
    }, timeoutMs);

    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.stderr.on('data', (c: Buffer) => err.push(c));
    child.on('error', (e) => done(() => reject(new Error(`Không chạy được ffmpeg: ${(e as NodeJS.ErrnoException).code ?? e.message}`))));
    child.on('close', (code) => {
      if (code === 0) done(() => resolve(Buffer.concat(out)));
      else done(() => reject(new Error(`ffmpeg lỗi (mã ${code}): ${Buffer.concat(err).toString('utf8').slice(0, 300)}`)));
    });
    // EPIPE khi ffmpeg thoát sớm sẽ được báo qua 'close' với mã lỗi
    child.stdin.on('error', () => undefined);
    if (input) child.stdin.end(Buffer.from(input));
    else child.stdin.end();
  });
}

/** Giải mã bất kỳ định dạng audio (wav/mp3/...) thành PCM 24 kHz mono s16le. */
export async function decodeToPcm(audio: Uint8Array): Promise<Buffer> {
  const pcm = await runFfmpeg(['-i', 'pipe:0', '-vn', '-f', 's16le', '-acodec', 'pcm_s16le', '-ac', '1', '-ar', String(SAMPLE_RATE), 'pipe:1'], audio);
  if (pcm.length === 0) throw new Error('Audio rỗng sau khi giải mã');
  // đảm bảo số byte chẵn (mỗi mẫu 2 byte)
  return pcm.length % 2 === 0 ? pcm : pcm.subarray(0, pcm.length - 1);
}

/**
 * Mã hóa PCM chuẩn thành MP3 (mặc định 128 kbps) cho phát và tải về.
 * Ghi ra TỆP TẠM thay vì pipe: ffmpeg cần ghi lùi thẻ Xing/LAME (chứa độ trễ bộ mã hóa) vào đầu tệp,
 * nhờ đó trình phát bù đúng độ trễ và highlight không bị lệch so với mốc thời gian tính theo PCM.
 */
export async function encodeMp3(pcm: Buffer, bitrateKbps = 128): Promise<Buffer> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'submaker-mp3-'));
  const outFile = path.join(dir, 'out.mp3');
  try {
    await runFfmpeg(
      ['-f', 's16le', '-ar', String(SAMPLE_RATE), '-ac', '1', '-i', 'pipe:0', '-codec:a', 'libmp3lame', '-b:a', `${bitrateKbps}k`, '-write_xing', '1', '-y', outFile],
      pcm,
    );
    return await readFile(outFile);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Mã hóa MP3 từ tệp PCM thô trên đĩa (dùng cho kịch bản dài, không giữ PCM trong bộ nhớ). Trả về đường dẫn tệp mp3. */
export async function encodeMp3FromFile(pcmPath: string, mp3Path: string, bitrateKbps = 128): Promise<void> {
  await runFfmpeg(
    ['-f', 's16le', '-ar', String(SAMPLE_RATE), '-ac', '1', '-i', pcmPath, '-codec:a', 'libmp3lame', '-b:a', `${bitrateKbps}k`, '-write_xing', '1', '-y', mp3Path],
    null,
    10 * 60_000,
  );
}

export async function ffmpegAvailable(): Promise<boolean> {
  try {
    await runFfmpeg(['-version'], null, 10_000);
    return true;
  } catch {
    return false;
  }
}

// ---- WAV bao quanh PCM (lưu cache từng đoạn) -------------------------------------------------

export function pcmToWav(pcm: Buffer): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * BYTES_PER_SAMPLE, 28);
  header.writeUInt16LE(BYTES_PER_SAMPLE, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** Lấy PCM thô từ WAV do `pcmToWav` sinh ra (duyệt chunk để tìm "data"). */
export function wavToPcm(wav: Buffer): Buffer {
  if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Tệp cache không phải WAV hợp lệ');
  }
  let off = 12;
  while (off + 8 <= wav.length) {
    const id = wav.toString('ascii', off, off + 4);
    const size = wav.readUInt32LE(off + 4);
    if (id === 'data') return wav.subarray(off + 8, off + 8 + size);
    off += 8 + size + (size % 2);
  }
  throw new Error('WAV không có chunk data');
}

export const pcmDurationMs = (pcm: Buffer): number => Math.round((pcm.length / BYTES_PER_SAMPLE / SAMPLE_RATE) * 1000);

// ---- STT (spec 004): đo media và tách âm thanh -----------------------------------------------

const FFPROBE = () => process.env.FFPROBE_PATH || 'ffprobe';

export type MediaProbe = { durationMs: number | null; hasAudio: boolean; hasVideo: boolean };

/** Đo thời lượng và các luồng của tệp media bằng ffprobe (không đọc toàn bộ tệp vào bộ nhớ). */
export function probeMedia(inputPath: string, timeoutMs = 60_000): Promise<MediaProbe> {
  return new Promise((resolve, reject) => {
    const child = spawn(FFPROBE(), ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', inputPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.stderr.on('data', (c: Buffer) => err.push(c));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`Không chạy được ffprobe: ${(e as NodeJS.ErrnoException).code ?? e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new MediaUnreadableError(Buffer.concat(err).toString('utf8').slice(0, 300)));
      try {
        const j = JSON.parse(Buffer.concat(out).toString('utf8')) as { format?: { duration?: string }; streams?: Array<{ codec_type?: string }> };
        const d = Number(j.format?.duration);
        const streams = j.streams ?? [];
        resolve({
          durationMs: Number.isFinite(d) && d > 0 ? Math.round(d * 1000) : null,
          hasAudio: streams.some((s) => s.codec_type === 'audio'),
          hasVideo: streams.some((s) => s.codec_type === 'video'),
        });
      } catch {
        reject(new MediaUnreadableError('ffprobe trả kết quả không đọc được'));
      }
    });
  });
}

/** Tệp media hỏng hoặc không đọc được (lỗi vĩnh viễn của STT job). */
export class MediaUnreadableError extends Error {
  constructor(detail: string) {
    super(`Không đọc được tệp media: ${detail}`);
    this.name = 'MediaUnreadableError';
  }
}

/** Tệp không có luồng âm thanh (FR-002, edge case "video không có tiếng"). */
export class NoAudioStreamError extends Error {
  constructor() {
    super('NO_AUDIO_STREAM');
    this.name = 'NoAudioStreamError';
  }
}

export type ExtractOptions = {
  timeoutMs?: number;
  /** chỉ số tuyệt đối của luồng tiếng cần tách (theo ffprobe); bỏ trống thì luồng tiếng đầu */
  audioIndex?: number;
  /** tệp không tin cậy: ép bộ tách theo đuôi và chỉ cho giao thức `file` */
  demuxer?: Demuxer;
};

/** Tham số tách âm thanh; dùng chung cho tiến trình chạy có theo dõi của dịch video. */
export function extractAudioArgs(inputPath: string, outPath: string, opts: Pick<ExtractOptions, 'audioIndex' | 'demuxer'> = {}): string[] {
  return [
    ...(opts.demuxer ? ['-protocol_whitelist', 'file', '-f', opts.demuxer] : []),
    '-i', inputPath,
    '-vn', '-map', opts.audioIndex === undefined ? '0:a:0' : `0:${opts.audioIndex}`,
    '-af', 'aresample=async=1:first_pts=0',
    '-acodec', 'libmp3lame', '-q:a', '4', '-ac', '1', '-ar', '16000',
    '-y', outPath,
  ];
}

/**
 * Tách luồng âm thanh thành MP3 mono 16 kHz (FR-002, research R2) từ tệp trên đĩa sang tệp trên đĩa.
 * Không có luồng âm thanh → NoAudioStreamError.
 *
 * Mốc phụ đề tính theo âm thanh này, nên nó phải cùng dòng thời gian với video: MP3 không lưu mốc, vì vậy khoảng lệch đầu luồng
 * và quãng hở giữa luồng được điền im lặng (`aresample=async=1:first_pts=0`).
 */
export async function extractAudioToMp3File(inputPath: string, outPath: string, options: number | ExtractOptions = {}): Promise<void> {
  const opts = typeof options === 'number' ? { timeoutMs: options } : options;
  // đã chỉ định luồng thì người gọi đã đo tệp (probeVideo)
  if (opts.audioIndex === undefined) {
    const probe = await probeMedia(inputPath);
    if (!probe.hasAudio) throw new NoAudioStreamError();
  }
  await runFfmpeg(extractAudioArgs(inputPath, outPath, opts), null, opts.timeoutMs ?? 15 * 60_000);
}

// ---- Dịch video (spec 006): đo video nguồn ------------------------------------------------------

export type Demuxer = 'mov' | 'matroska' | 'avi' | 'flv';

const DEMUXERS: Record<string, Demuxer> = { mp4: 'mov', m4v: 'mov', mov: 'mov', mkv: 'matroska', webm: 'matroska', avi: 'avi', flv: 'flv' };

/** Bộ tách bị ép theo đuôi tệp: tệp đổi đuôi hoặc danh sách phát giả dạng không được "đoán" thành định dạng khác. */
export function demuxerOf(ext: string): Demuxer {
  const d = DEMUXERS[ext.toLowerCase()];
  if (!d) throw new Error(`Không hỗ trợ đuôi .${ext}`);
  return d;
}

/** Giới hạn độ phân giải được nhận (4K DCI), tính trên kích thước hiển thị. */
export const MAX_VIDEO_LONG_SIDE = 4096;
export const MAX_VIDEO_SHORT_SIDE = 2304;

export class NoVideoStreamError extends Error {
  constructor() {
    super('NO_VIDEO_STREAM');
    this.name = 'NoVideoStreamError';
  }
}
export class VideoResolutionError extends Error {
  constructor(width: number, height: number) {
    super(`Độ phân giải ${width}×${height} vượt mức hỗ trợ`);
    this.name = 'VideoResolutionError';
  }
}
export class VideoTooLongError extends Error {
  constructor(durationMs: number) {
    super(`Video dài ${Math.round(durationMs / 1000)} giây, vượt mức cho phép`);
    this.name = 'VideoTooLongError';
  }
}

type ProbeStream = {
  index: number;
  codec_type?: string;
  codec_name?: string;
  pix_fmt?: string;
  width?: number;
  height?: number;
  sample_aspect_ratio?: string;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  bit_rate?: string;
  start_time?: string;
  duration?: string;
  color_space?: string;
  color_transfer?: string;
  disposition?: { default?: number; attached_pic?: number };
  tags?: Record<string, string>;
  side_data_list?: Array<{ rotation?: number }>;
};
type ProbeOutput = { format?: { duration?: string; bit_rate?: string; start_time?: string; size?: string }; streams?: ProbeStream[] };

const num = (v: string | number | undefined): number | null => {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) ? n : null;
};

function ratio(v: string | undefined): number | null {
  const m = /^(\d+)[/:](\d+)$/.exec(v ?? '');
  if (!m || Number(m[2]) === 0 || Number(m[1]) === 0) return null;
  return Number(m[1]) / Number(m[2]);
}

/** Thời lượng riêng của một luồng; Matroska chỉ ghi ở thẻ `DURATION` (hh:mm:ss.f, tính từ mốc 0 của tệp). */
function streamDuration(s: ProbeStream, startSec: number): number | null {
  const direct = num(s.duration);
  if (direct !== null) return direct;
  const tag = /^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(s.tags?.DURATION ?? s.tags?.['DURATION-eng'] ?? '');
  return tag ? Number(tag[1]) * 3600 + Number(tag[2]) * 60 + Number(tag[3]) - startSec : null;
}

const PLAYABLE: Record<'mov' | 'matroska', { video: string[]; audio: string[] }> = {
  mov: { video: ['h264'], audio: ['aac', 'mp3'] },
  matroska: { video: ['vp8', 'vp9', 'av1'], audio: ['opus', 'vorbis'] },
};

export function runFfprobeJson(args: string[], timeoutMs = 60_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(FFPROBE(), ['-v', 'error', ...args, '-of', 'json'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.stderr.on('data', (c: Buffer) => {
      if (err.length < 32) err.push(c);
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`Không chạy được ffprobe: ${(e as NodeJS.ErrnoException).code ?? e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new MediaUnreadableError(Buffer.concat(err).toString('utf8').slice(0, 300)));
      try {
        resolve(JSON.parse(Buffer.concat(out).toString('utf8')));
      } catch {
        reject(new MediaUnreadableError('ffprobe trả kết quả không đọc được'));
      }
    });
  });
}

/**
 * Đo video nguồn (contracts/render-and-media.md §4) và từ chối tệp không đạt: không đọc được, không có hình, không có tiếng, quá
 * 4096×2304 hoặc dài quá giới hạn. Tệp được coi là không tin cậy: chỉ giao thức `file`, bộ tách ép theo đuôi.
 */
export async function probeVideo(inputPath: string, opts: { demuxer: Demuxer; maxMinutes: number; timeoutMs?: number }): Promise<VideoMedia> {
  const raw = (await runFfprobeJson(
    ['-protocol_whitelist', 'file', '-f', opts.demuxer, '-show_format', '-show_streams', inputPath],
    opts.timeoutMs,
  )) as ProbeOutput;
  const streams = raw.streams ?? [];
  // ảnh bìa đính kèm tệp âm thanh không phải hình của video
  const video = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic && (s.width ?? 0) > 0 && (s.height ?? 0) > 0);
  const audios = streams.filter((s) => s.codec_type === 'audio');
  if (!video && audios.length === 0) throw new MediaUnreadableError('không có luồng hình hay tiếng');
  if (!video) throw new NoVideoStreamError();
  if (audios.length === 0) throw new NoAudioStreamError();
  const audio = audios.find((s) => s.disposition?.default) ?? audios[0]!;
  if (!video.codec_name || !audio.codec_name) throw new MediaUnreadableError('bộ mã không đọc được');

  const startSec = num(raw.format?.start_time) ?? 0;
  const durationSec = num(raw.format?.duration) ?? streamDuration(video, startSec);
  if (durationSec === null || durationSec <= 0) throw new MediaUnreadableError('không đo được thời lượng');

  const sar = ratio(video.sample_aspect_ratio) ?? 1;
  const squareWidth = Math.round(video.width! * sar);
  const rotation = (((video.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? num(video.tags?.rotate) ?? 0) % 360) + 360) % 360;
  const turned = rotation % 180 !== 0;
  const width = turned ? video.height! : squareWidth;
  const height = turned ? squareWidth : video.height!;
  if (Math.max(width, height) > MAX_VIDEO_LONG_SIDE || Math.min(width, height) > MAX_VIDEO_SHORT_SIDE) throw new VideoResolutionError(width, height);
  if (durationSec > opts.maxMinutes * 60) throw new VideoTooLongError(durationSec * 1000);

  const audioStartSec = (num(audio.start_time) ?? startSec) - startSec;
  const audioDurationSec = streamDuration(audio, num(audio.start_time) ?? startSec) ?? Math.max(0, durationSec - audioStartSec);
  const size = num(raw.format?.size) ?? 0;
  const videoBitrate = num(video.bit_rate) ?? Math.max(0, (num(raw.format?.bit_rate) ?? (size * 8) / durationSec) - (num(audio.bit_rate) ?? 0));
  const fps = ratio(video.avg_frame_rate) ?? ratio(video.r_frame_rate) ?? 30;
  const hdr = video.color_transfer === 'smpte2084' || video.color_transfer === 'arib-std-b67';
  const matrix = video.color_space === 'bt709' ? 'bt709' : video.color_space === 'smpte170m' || video.color_space === 'bt470bg' ? 'bt601' : height >= 720 || width >= 1280 ? 'bt709' : 'bt601';
  const family = opts.demuxer === 'mov' || opts.demuxer === 'matroska' ? PLAYABLE[opts.demuxer] : null;
  const eightBit = !video.pix_fmt || video.pix_fmt === 'yuv420p' || video.pix_fmt === 'yuvj420p';
  return {
    durationMs: Math.round(durationSec * 1000),
    width,
    height,
    fps: Math.round(fps * 1000) / 1000,
    videoCodec: video.codec_name,
    videoBitrate: Math.round(videoBitrate),
    audioCodec: audio.codec_name,
    audioIndex: audio.index,
    audioStartMs: Math.round(audioStartSec * 1000),
    audioDurationMs: Math.round(audioDurationSec * 1000),
    audioStreams: audios.length,
    audioNumber: audios.indexOf(audio) + 1,
    rotation,
    hdr,
    matrix,
    browserPlayable: !!family && eightBit && family.video.includes(video.codec_name) && family.audio.includes(audio.codec_name),
  };
}

/** Bản dùng bộ nhớ (kiểm thử, tệp nhỏ): media → MP3 mono 16 kHz. */
export async function extractAudioFromMedia(inputBuffer: Buffer | Uint8Array, ext: string): Promise<Buffer> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'submaker-stt-'));
  const safeExt = ext.replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'bin';
  const inFile = path.join(dir, `in.${safeExt}`);
  const outFile = path.join(dir, 'out.mp3');
  try {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(inFile, Buffer.from(inputBuffer));
    await extractAudioToMp3File(inFile, outFile);
    return await readFile(outFile);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
