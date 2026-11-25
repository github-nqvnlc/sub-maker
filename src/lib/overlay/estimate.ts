import type { OverlayConfig } from './config';

/**
 * Ước tính dung lượng video (FR-034, research R11). ĐÂY LÀ ƯỚC TÍNH, không phải cam kết: số đo trên khung 1080×1920, đơn vị MB mỗi phút,
 * lấy mức cao của các cảnh đã đo để ít khi thấp hơn thực tế. Máy chủ luôn tính lại, và hạn mức được trừ theo dung lượng thật.
 */
const VIDEO_MB_PER_MIN: Record<OverlayConfig['format'], number> = { mp4: 3.1, webm: 5.1, mov: 210 };
const AUDIO_MB_PER_MIN = 1.4;
/** Khung vuông có ít điểm ảnh hơn nhưng vùng chữ vẫn vậy. */
const AREA_FACTOR: Record<OverlayConfig['aspect'], number> = { '9:16': 1, '16:9': 1, '1:1': 0.85 };
/** .mov nén từng khung riêng nên phình theo vùng bán trong suốt và cỡ chữ: thêm chừng này cho bóng mờ và cho hộp nền. */
const MOV_SOFT_MB_PER_MIN = 110;
const MOV_REF_FONT = 72;
const MOV_MIN_FONT_FACTOR = 0.6;
/** Rung suốt câu: khung nào cũng khác khung trước nên hai định dạng nén theo chuyển động lớn hơn. */
const SHAKE_FACTOR = 2.5;
const MIN_BYTES = 100 * 1024;

export type EstimateInput = Pick<OverlayConfig, 'format' | 'aspect' | 'includeAudio' | 'font' | 'shadow' | 'box' | 'sync' | 'enter' | 'shakeScope'>;

function videoRate(c: EstimateInput): number {
  if (c.format !== 'mov') return VIDEO_MB_PER_MIN[c.format] * (c.sync !== 'word' && c.enter === 'shake' && c.shakeScope === 'all' ? SHAKE_FACTOR : 1);
  const soft = (c.shadow.enabled && c.shadow.blur > 0 ? 1 : 0) + (c.box.enabled && c.box.opacity > 0 ? 1 : 0);
  return (VIDEO_MB_PER_MIN.mov + soft * MOV_SOFT_MB_PER_MIN) * Math.max(MOV_MIN_FONT_FACTOR, c.font.size / MOV_REF_FONT);
}

export function estimateBytes(c: EstimateInput, durationMs: number): number {
  const minutes = Math.max(0, durationMs) / 60_000;
  const mb = (videoRate(c) * AREA_FACTOR[c.aspect] + (c.includeAudio ? AUDIO_MB_PER_MIN : 0)) * minutes;
  return Math.max(MIN_BYTES, Math.ceil(mb * 1024 * 1024));
}
