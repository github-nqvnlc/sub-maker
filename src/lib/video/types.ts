/**
 * Kiểu dữ liệu dùng chung của tính năng dịch video (spec 006, data-model). Mã thuần: không phụ thuộc DOM, Node hay CSDL.
 */

export const VIDEO_EXTENSIONS = ['mp4', 'mov', 'mkv', 'webm', 'avi', 'flv', 'm4v'] as const;
export type VideoExtension = (typeof VIDEO_EXTENSIONS)[number];

/** Kiểu nội dung khi lưu và phát video nguồn. */
export const VIDEO_CONTENT_TYPES: Record<VideoExtension, string> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  webm: 'video/webm',
  avi: 'video/x-msvideo',
  flv: 'video/x-flv',
};

/** Hướng dịch (FR-012). */
export const DIRECTIONS = ['to_vi', 'vi_to_en'] as const;
export type Direction = (typeof DIRECTIONS)[number];
export const TARGET_LANGUAGE: Record<Direction, 'vi' | 'en'> = { to_vi: 'vi', vi_to_en: 'en' };

export const SOURCE_STATES = ['uploading', 'checking', 'ready', 'deleted', 'rejected'] as const;
export type SourceState = (typeof SOURCE_STATES)[number];

export const PREVIEW_STATES = ['none', 'pending', 'ready', 'failed'] as const;
export type PreviewState = (typeof PREVIEW_STATES)[number];

export const UPLOAD_KINDS = ['source', 'client_audio'] as const;
export type UploadKind = (typeof UPLOAD_KINDS)[number];

export const UPLOAD_STATES = ['active', 'completing', 'completed', 'aborted'] as const;
export type UploadState = (typeof UPLOAD_STATES)[number];

export const CUE_TIMINGS = ['measured', 'estimated', 'manual'] as const;
export type CueTiming = (typeof CUE_TIMINGS)[number];

export const EXPORT_KINDS = ['burn', 'layer'] as const;
export type ExportKind = (typeof EXPORT_KINDS)[number];
export const EXPORT_FORMATS = ['mp4', 'mov'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/** Cặp từ điển thuật ngữ (FR-019). */
export type GlossaryPair = { source: string; target: string; keep: boolean };

export type CueFlags = { untranslated?: boolean; fast?: boolean; review?: boolean };

/** Một đơn vị phụ đề đã lưu (data-model §1.4). */
export type Cue = {
  id: string;
  startMs: number;
  endMs: number;
  timing: CueTiming;
  sourceText: string;
  targetText: string;
  sourceLang: string | null;
  speaker: string | null;
  flags: CueFlags;
};

/** Kết quả đo video nguồn bằng ffprobe (data-model §1.2). `width`/`height` là kích thước hiển thị (sau xoay và điểm ảnh vuông). */
export type VideoMedia = {
  durationMs: number;
  width: number;
  height: number;
  fps: number;
  videoCodec: string;
  /** bit/giây của luồng hình */
  videoBitrate: number;
  audioCodec: string;
  /** chỉ số luồng tiếng được dùng (theo ffprobe) */
  audioIndex: number;
  audioStartMs: number;
  audioDurationMs: number;
  /** số luồng tiếng trong tệp */
  audioStreams: number;
  /** thứ tự (từ 1) của luồng được dùng trong các luồng tiếng */
  audioNumber?: number;
  rotation: number;
  hdr: boolean;
  /** ma trận màu của nguồn SDR */
  matrix: 'bt709' | 'bt601';
  /** trình duyệt phổ biến phát được nguồn (không cần bản xem trước vì định dạng) */
  browserPlayable: boolean;
};

export const CUE_LIMITS = {
  maxCues: 20_000,
  minDurationMs: 100,
  maxTextChars: 2000,
} as const;

/** Số byte chữ của một cue, tính vào hạn mức 500 MB (FR-055). */
export const cueBytes = (c: Pick<Cue, 'sourceText' | 'targetText'>): number => utf8Length(c.sourceText) + utf8Length(c.targetText);

function utf8Length(s: string): number {
  let n = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    n += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return n;
}
