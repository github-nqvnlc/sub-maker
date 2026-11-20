import { BYTES_PER_SAMPLE, SAMPLE_RATE, runFfmpeg } from './ffmpeg';

/**
 * Nén thời lượng PCM bằng `atempo` của ffmpeg (giữ cao độ) — spec 003, research R3. `factor` > 1 là nhanh hơn
 * (độ dài ra ≈ độ dài vào / factor). `atempo` nhận 0,5–2; hệ thống chỉ dùng ≤ 1,5 nên một lượt là đủ.
 */
export async function tempoPcm(pcm: Buffer, factor: number): Promise<Buffer> {
  if (!Number.isFinite(factor) || factor < 1 || factor > 2) throw new Error(`Hệ số nén ngoài khoảng 1–2: ${factor}`);
  if (factor === 1 || pcm.length === 0) return pcm;
  const out = await runFfmpeg(
    ['-f', 's16le', '-ar', String(SAMPLE_RATE), '-ac', '1', '-i', 'pipe:0', '-filter:a', `atempo=${factor.toFixed(6)}`, '-f', 's16le', '-ac', '1', '-ar', String(SAMPLE_RATE), 'pipe:1'],
    pcm,
  );
  return out.length % BYTES_PER_SAMPLE === 0 ? out : out.subarray(0, out.length - 1);
}
