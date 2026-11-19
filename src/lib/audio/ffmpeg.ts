import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Giải mã/mã hóa audio bằng ffmpeg (có sẵn trong ảnh worker). PCM chuẩn của hệ thống:
 * 24 kHz, mono, 16-bit little-endian — mọi đoạn đều được đưa về dạng này trước khi ghép nên không bị
 * "lách tách" do khác tần số/kênh (docs/fpt-ai-voice-guide.md §10).
 */
export const SAMPLE_RATE = 24_000;
export const BYTES_PER_SAMPLE = 2;

const FFMPEG = () => process.env.FFMPEG_PATH || 'ffmpeg';

function runFfmpeg(args: string[], input: Buffer | Uint8Array | null, timeoutMs = 120_000): Promise<Buffer> {
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
