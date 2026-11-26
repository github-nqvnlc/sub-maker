import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runFfmpeg } from '@/lib/audio/ffmpeg';

/** Tạo video thử ngắn bằng ffmpeg cho kiểm thử tích hợp (spec 006: video thử ≤ 10 giây). */
export type TestVideoOptions = {
  ext?: 'mp4' | 'mkv' | 'webm' | 'avi' | 'mov';
  seconds?: number;
  size?: string;
  rate?: number;
  /** giây; tiếng bắt đầu muộn hơn hình */
  audioDelay?: number;
  audioSeconds?: number;
  audio?: boolean;
  video?: boolean;
  /** tham số mã hóa thay mặc định */
  videoCodec?: string[];
  audioCodec?: string[];
};

export async function makeTestVideo(o: TestVideoOptions = {}): Promise<Buffer> {
  const { ext = 'mp4', seconds = 3, size = '320x180', rate = 25, audioDelay = 0, audio = true, video = true } = o;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tv-'));
  try {
    const file = path.join(dir, `v.${ext}`);
    const args: string[] = [];
    if (video) args.push('-f', 'lavfi', '-i', `testsrc2=s=${size}:r=${rate}:d=${seconds}`);
    if (audio) {
      if (audioDelay) args.push('-itsoffset', String(audioDelay));
      args.push('-f', 'lavfi', '-i', `sine=frequency=600:duration=${o.audioSeconds ?? seconds - audioDelay}`);
    }
    if (video) args.push(...(o.videoCodec ?? (ext === 'webm' ? ['-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8'] : ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p'])));
    if (audio) args.push(...(o.audioCodec ?? (ext === 'webm' ? ['-c:a', 'libopus'] : ['-c:a', 'aac'])));
    await runFfmpeg([...args, '-y', file], null);
    return await readFile(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
