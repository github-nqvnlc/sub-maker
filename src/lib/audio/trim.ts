import { BYTES_PER_SAMPLE, SAMPLE_RATE } from './pcm';

/**
 * Cắt khoảng lặng ĐẦU và CUỐI của PCM nhà cung cấp trả về (spec 003, research R3): thời lượng đọc thật phản ánh
 * lời nói, không gồm vài trăm ms im lặng nhà cung cấp thêm vào. Giữ lại `keepMs` quanh đoạn có tiếng để không cụt âm.
 * PCM chuẩn: 24 kHz mono 16-bit little-endian. Hàm thuần JS, không cần ffmpeg.
 */

export type TrimOptions = { thresholdDb?: number; keepMs?: number };

export function trimSilence(pcm: Buffer, opts: TrimOptions = {}): Buffer {
  const thresholdDb = opts.thresholdDb ?? -45;
  const keepSamples = Math.round(((opts.keepMs ?? 30) * SAMPLE_RATE) / 1000);
  const threshold = Math.round(32768 * 10 ** (thresholdDb / 20));
  const n = Math.floor(pcm.length / BYTES_PER_SAMPLE);
  if (n === 0) return pcm;

  let first = -1;
  let last = -1;
  for (let i = 0; i < n; i++) {
    if (Math.abs(pcm.readInt16LE(i * BYTES_PER_SAMPLE)) > threshold) {
      first = i;
      break;
    }
  }
  if (first < 0) return Buffer.alloc(BYTES_PER_SAMPLE); // toàn im lặng: giữ một mẫu hợp lệ
  for (let i = n - 1; i >= first; i--) {
    if (Math.abs(pcm.readInt16LE(i * BYTES_PER_SAMPLE)) > threshold) {
      last = i;
      break;
    }
  }
  const from = Math.max(0, first - keepSamples);
  const to = Math.min(n, last + 1 + keepSamples);
  return pcm.subarray(from * BYTES_PER_SAMPLE, to * BYTES_PER_SAMPLE);
}
