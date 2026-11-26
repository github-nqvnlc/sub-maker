import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractAudioFromMedia, extractAudioToMp3File, ffmpegAvailable, NoAudioStreamError, probeMedia, runFfmpeg } from '@/lib/audio/ffmpeg';

const fx = (n: string) => path.resolve(process.cwd(), 'tests/fixtures', n);
const ok = await ffmpegAvailable();

async function inTempDir(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mx-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Giải mã tệp âm thanh: thời lượng, và thời điểm đầu tiên có tiếng kể từ `fromMs`. */
async function loudness(file: string) {
  const rate = 16_000;
  const pcm = await runFfmpeg(['-i', file, '-f', 's16le', '-ac', '1', '-ar', String(rate), 'pipe:1'], null);
  const samples = pcm.length / 2;
  return {
    durationMs: (samples / rate) * 1000,
    onsetMs(fromMs: number): number {
      for (let i = Math.round((fromMs / 1000) * rate); i < samples; i++) {
        if (Math.abs(pcm.readInt16LE(i * 2)) > 1000) return (i / rate) * 1000;
      }
      return -1;
    },
  };
}

/** Sai số cho phép do khung mã hóa AAC/MP3. */
const expectNear = (actualMs: number, wantMs: number) => {
  expect(actualMs).toBeGreaterThan(wantMs - 100);
  expect(actualMs).toBeLessThan(wantMs + 100);
};

describe('trích xuất âm thanh bằng FFmpeg (spec 004, FR-002)', () => {
  it.skipIf(!ok)('video → MP3 mono 16 kHz, không còn luồng hình', async () => {
    const video = await readFile(fx('sample-video-5s.mp4'));
    const mp3 = await extractAudioFromMedia(video, 'mp4');
    expect(mp3.length).toBeGreaterThan(1000);
    expect(mp3.length).toBeLessThan(video.length);
    const dir = await mkdtemp(path.join(os.tmpdir(), 'mx-'));
    try {
      await writeFile(path.join(dir, 'a.mp3'), mp3);
      const p = await probeMedia(path.join(dir, 'a.mp3'));
      expect(p.hasAudio).toBe(true);
      expect(p.hasVideo).toBe(false);
      expect(p.durationMs).toBeGreaterThan(4000);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!ok)('báo lỗi sớm khi video không có luồng âm thanh', async () => {
    const video = await readFile(fx('sample-silent-video.mp4'));
    await expect(extractAudioFromMedia(video, 'mp4')).rejects.toBeInstanceOf(NoAudioStreamError);
  });

  // Mốc phụ đề tính theo âm thanh gửi đi, nên âm thanh phải giữ đúng vị trí trên dòng thời gian của video.
  it.skipIf(!ok).each(['mp4', 'mkv'])('.%s: tiếng bắt đầu muộn hơn hình thì phần đầu là im lặng', async (ext) => {
    await inTempDir(async (dir) => {
      const video = path.join(dir, `late.${ext}`);
      const out = path.join(dir, 'out.mp3');
      // hình 6 giây từ giây 0, tiếng 2 giây bắt đầu ở giây 1,5
      await runFfmpeg(
        ['-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=10:d=6', '-itsoffset', '1.5', '-f', 'lavfi', '-i', 'sine=frequency=800:duration=2',
          '-map', '0:v', '-map', '1:a', '-c:v', 'mpeg4', '-c:a', 'aac', video],
        null,
      );
      await extractAudioToMp3File(video, out);
      const { onsetMs, durationMs } = await loudness(out);
      expectNear(onsetMs(0), 1500);
      expectNear(durationMs, 3500);
    });
  });

  it.skipIf(!ok)('quãng hở giữa luồng tiếng được giữ thành im lặng', async () => {
    await inTempDir(async (dir) => {
      const video = path.join(dir, 'gap.mkv');
      const out = path.join(dir, 'out.mp3');
      // tiếng ở [0, 1) và [3, 5) giây, ở giữa không có gói âm thanh nào
      await runFfmpeg(
        ['-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=10:d=5', '-f', 'lavfi', '-i', 'sine=frequency=800:duration=5',
          '-map', '0:v', '-map', '1:a', '-af', "aselect='lt(t,1)+gte(t,3)'", '-c:v', 'mpeg4', '-c:a', 'aac', video],
        null,
      );
      await extractAudioToMp3File(video, out);
      const { onsetMs, durationMs } = await loudness(out);
      expectNear(onsetMs(0), 0);
      expectNear(onsetMs(1500), 3000);
      expectNear(durationMs, 5000);
    });
  });

  it.skipIf(!ok)('ffprobe đo thời lượng tệp audio', async () => {
    const p = await probeMedia(fx('sample-10s.mp3'));
    expect(p.hasAudio).toBe(true);
    expect(Math.round((p.durationMs ?? 0) / 1000)).toBe(10);
  });
});
