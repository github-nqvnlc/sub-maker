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

/**
 * Gắn cứng phụ đề lên video nguồn (spec 006, contracts/render-and-media.md §3): lớp chữ chỉ là dải ngang RGBA (alpha nhân sẵn) vào từ
 * stdin; video nguồn là tệp không tin cậy nên chỉ đọc từ đĩa với bộ tách ép theo đuôi. Tên tệp do hệ thống đặt.
 */
export type BurnEncodeInput = {
  source: { path: string; demuxer: 'mov' | 'matroska' | 'avi' | 'flv'; audioIndex: number; hdr: boolean; matrix: 'bt709' | 'bt601'; copyAudio: boolean };
  /** kích thước thành phẩm */
  width: number;
  height: number;
  band: { y: number; height: number };
  /** số khung chữ mỗi giây */
  fps: number;
  maxrate: number;
  outPath: string;
  threads: number;
};

/** HDR (PQ, HLG) về SDR BT.709. */
const TONEMAP = 'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p,';

export function burnArgs(i: BurnEncodeInput): string[] {
  const matrix = i.source.hdr ? 'bt709' : i.source.matrix;
  const filter = [
    `[0:v:0]${i.source.hdr ? TONEMAP : ''}scale=${i.width}:${i.height}:flags=bicubic,setsar=1[base]`,
    `[1:v]scale=out_color_matrix=${matrix}:out_range=tv,format=yuva420p[sub]`,
    `[base][sub]overlay=0:${i.band.y}:alpha=premultiplied:eof_action=pass[v]`,
  ].join(';');
  const colour = matrix === 'bt601' ? ['-colorspace', 'smpte170m'] : ['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709'];
  return [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-threads', String(i.threads),
    '-protocol_whitelist', 'file', '-f', i.source.demuxer, '-i', i.source.path,
    '-protocol_whitelist', 'pipe', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${i.width}x${i.band.height}`, '-r', String(i.fps), '-i', 'pipe:0',
    '-filter_complex', filter,
    '-map', '[v]', '-map', `0:${i.source.audioIndex}`,
    '-fps_mode', 'passthrough',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-maxrate', String(i.maxrate), '-bufsize', String(i.maxrate * 2), '-pix_fmt', 'yuv420p',
    ...colour,
    ...(i.source.copyAudio ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '192k']),
    '-movflags', '+faststart', '-map_metadata', '-1',
    '-threads', String(i.threads),
    i.outPath,
  ];
}

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
