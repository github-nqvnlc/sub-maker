import type { OverlayFormat } from '../../lib/overlay/config';
import { FPS, framesToMs } from '../../lib/overlay/frames';

/**
 * Tham số ffmpeg để mã hóa khung RGBA thô từ stdin (research R5). Là mảng cố định, không qua shell; không có chữ do người dùng nhập
 * (FR-046). Âm thanh luôn là MP3 do hệ thống tạo hoặc chuẩn hóa, chỉ đọc từ tệp trên đĩa.
 */
export type EncodeInput = { format: OverlayFormat; width: number; height: number; frames: number; audioPath: string | null; outPath: string; threads: number };

const VIDEO: Record<OverlayFormat, string[]> = {
  mp4: [
    '-vf', 'scale=out_color_matrix=bt709:out_range=tv',
    '-pix_fmt', 'yuv420p',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18',
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
    '-movflags', '+faststart',
  ],
  mov: ['-c:v', 'prores_ks', '-profile:v', '4444', '-qscale:v', '11', '-alpha_bits', '8', '-pix_fmt', 'yuva444p10le', '-vendor', 'apl0'],
  webm: ['-pix_fmt', 'yuva420p', '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '6', '-row-mt', '1', '-crf', '24', '-b:v', '0', '-auto-alt-ref', '0'],
};

const AUDIO: Record<OverlayFormat, string[]> = {
  mp4: ['-c:a', 'aac', '-b:a', '192k'],
  mov: ['-c:a', 'aac', '-b:a', '192k'],
  webm: ['-c:a', 'libopus', '-b:a', '128k'],
};

export function encodeArgs(i: EncodeInput): string[] {
  const seconds = (framesToMs(i.frames) / 1000).toFixed(6);
  return [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${i.width}x${i.height}`, '-r', String(FPS), '-i', 'pipe:0',
    ...(i.audioPath ? ['-protocol_whitelist', 'file', '-f', 'mp3', '-i', i.audioPath] : []),
    '-map', '0:v:0',
    ...(i.audioPath ? ['-map', '1:a:0', '-af', 'apad'] : ['-an']),
    ...VIDEO[i.format],
    ...(i.audioPath ? AUDIO[i.format] : []),
    // Cắt/đệm tiếng đúng bằng số khung: thời lượng video bằng thời lượng voice (FR-006)
    '-t', seconds,
    '-threads', String(i.threads),
    '-map_metadata', '-1',
    i.outPath,
  ];
}
