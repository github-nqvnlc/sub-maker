import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractAudioFromMedia, ffmpegAvailable, NoAudioStreamError, probeMedia } from '@/lib/audio/ffmpeg';

const fx = (n: string) => path.resolve(process.cwd(), 'tests/fixtures', n);
const ok = await ffmpegAvailable();

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

  it.skipIf(!ok)('ffprobe đo thời lượng tệp audio', async () => {
    const p = await probeMedia(fx('sample-10s.mp3'));
    expect(p.hasAudio).toBe(true);
    expect(Math.round((p.durationMs ?? 0) / 1000)).toBe(10);
  });
});
