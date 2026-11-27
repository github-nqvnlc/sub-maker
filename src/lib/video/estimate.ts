import { estimateBytes, type EstimateInput } from '../overlay/estimate';
import type { VideoStyle } from './style';
import type { VideoMedia } from './types';

/**
 * Ước tính bản xuất gắn cứng và lớp phụ đề (spec 006, research R3, R12; FR-038, FR-041, FR-042, FR-053). Hàm thuần, dùng chung cho
 * API ước tính và worker. Mọi con số là ƯỚC TÍNH: dung lượng thật chỉ biết sau khi dựng xong.
 */

const AUDIO_BPS = 192_000;
/** AC-3, E-AC-3 chép nguyên có thể tới mức này. */
const SURROUND_BPS = 640_000;
const CONTAINER_OVERHEAD = 1.05;
const MAX_OVERLAY_FPS = 60;
const LAYER_MIN_BYTES = 100 * 1024;
const LAYER_REF_PIXELS = 1080 * 1920;

/** Codec tiếng đặt thẳng được vào `.mp4` nên giữ nguyên chất lượng (FR-037). */
export const COPY_AUDIO_CODECS: ReadonlySet<string> = new Set(['aac', 'mp3', 'ac3', 'eac3']);

/** Sàn trần bitrate theo cạnh ngắn: đủ để vùng không có chữ không khác nguồn bằng mắt. */
const floorOf = (shortSide: number): number => (shortSide <= 720 ? 4_000_000 : shortSide <= 1080 ? 8_000_000 : shortSide <= 1440 ? 16_000_000 : 24_000_000);

export const burnMaxrate = (m: Pick<VideoMedia, 'width' | 'height' | 'videoBitrate'>): number => Math.max(Math.round(m.videoBitrate * 1.3), floorOf(Math.min(m.width, m.height)));

const even = (n: number): number => Math.max(2, Math.floor(n / 2) * 2);
/** Kích thước thành phẩm: kích thước hiển thị của nguồn, làm tròn xuống số chẵn. */
export const burnOutputSize = (m: Pick<VideoMedia, 'width' | 'height'>): { width: number; height: number } => ({ width: even(m.width), height: even(m.height) });

/** Số khung chữ vẽ mỗi giây. */
export const overlayFps = (sourceFps: number): number => (sourceFps > 0 ? Math.min(MAX_OVERLAY_FPS, sourceFps) : 30);

/** Tốc độ dựng so với thời gian thực, lấy dè dặt từ phép đo trong ảnh worker (research R1: 1080p 4×, 4K 1,2×). */
const speedOf = (pixels: number): number => Math.min(8, Math.max(0.8, 3 * (2_073_600 / pixels)));

export type EstimateWarning = { code: 'HDR' | 'ROUNDED_SIZE' | 'MISSING_GLYPH'; params?: Record<string, string | number> };

export type BurnEstimate = { bytes: number; seconds: number; width: number; height: number; warnings: EstimateWarning[] };

export function estimateBurn(media: Pick<VideoMedia, 'durationMs' | 'width' | 'height' | 'videoBitrate' | 'audioCodec' | 'hdr'>): BurnEstimate {
  const { width, height } = burnOutputSize(media);
  const seconds = media.durationMs / 1000;
  const audio = media.audioCodec === 'ac3' || media.audioCodec === 'eac3' ? SURROUND_BPS : AUDIO_BPS;
  const warnings: EstimateWarning[] = [];
  if (media.hdr) warnings.push({ code: 'HDR' });
  if (width !== media.width || height !== media.height) warnings.push({ code: 'ROUNDED_SIZE', params: { width, height } });
  return {
    bytes: Math.ceil(seconds * ((burnMaxrate(media) + audio) / 8) * CONTAINER_OVERHEAD),
    // thêm thời gian tải nguồn về và đưa thành phẩm lên kho
    seconds: Math.ceil(seconds / speedOf(width * height) + 30),
    width,
    height,
    warnings,
  };
}

/** Ước tính lớp phụ đề riêng: bảng spec 005 trên 1080×1920 nhân theo tỉ lệ diện tích khung nguồn, không tiếng (FR-041). */
export function estimateLayer(
  media: Pick<VideoMedia, 'durationMs' | 'width' | 'height'>,
  style: Pick<VideoStyle, 'font' | 'shadow' | 'box' | 'sync' | 'enter'>,
  format: 'mp4' | 'mov',
): BurnEstimate {
  const { width, height } = burnOutputSize(media);
  const seconds = media.durationMs / 1000;
  const baseBytes = estimateBytes(
    {
      aspect: '9:16',
      format,
      includeAudio: false,
      font: { ...style.font, weight: style.font.weight as EstimateInput['font']['weight'] },
      shadow: { enabled: style.shadow.enabled, color: style.shadow.color, blur: style.shadow.blur },
      box: { enabled: style.box.enabled, color: style.box.color, radius: style.box.radius, opacity: style.box.opacity },
      sync: style.sync,
      enter: style.enter,
      shakeScope: 'exclaim',
    },
    media.durationMs,
  );
  const warnings: EstimateWarning[] = [];
  if (width !== media.width || height !== media.height) warnings.push({ code: 'ROUNDED_SIZE', params: { width, height } });
  return {
    bytes: Math.max(LAYER_MIN_BYTES, Math.ceil((baseBytes * (width * height)) / LAYER_REF_PIXELS)),
    seconds: Math.ceil(seconds / speedOf(width * height) + 20),
    width,
    height,
    warnings,
  };
}
