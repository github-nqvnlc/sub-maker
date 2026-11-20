/**
 * PCM chuẩn của hệ thống: 24 kHz, mono, 16-bit little-endian. Tách riêng khỏi ffmpeg.ts để các hàm thuần (placement, trim)
 * và lớp API nhập được mà không kéo mã chạy tiến trình con ffmpeg vào bundle web.
 */
export const SAMPLE_RATE = 24_000;
export const BYTES_PER_SAMPLE = 2;
