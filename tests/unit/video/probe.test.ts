import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  demuxerOf,
  ffmpegAvailable,
  MediaUnreadableError,
  NoAudioStreamError,
  NoVideoStreamError,
  probeVideo,
  runFfmpeg,
  VideoResolutionError,
  VideoTooLongError,
} from '@/lib/audio/ffmpeg';

/** Đo video nguồn (spec 006, T029; FR-003, contracts/render-and-media.md §4). */
const ok = await ffmpegAvailable();
let dir: string;
const out = (name: string) => path.join(dir, name);

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'probe-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const video = (size = '320x180', d = 2, rate = 25) => ['-f', 'lavfi', '-i', `testsrc2=s=${size}:r=${rate}:d=${d}`];
const tone = (d = 2, freq = 600) => ['-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=${d}`];
const x264 = ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p'];

async function make(name: string, args: string[]): Promise<string> {
  await runFfmpeg([...args, '-y', out(name)], null);
  return out(name);
}
const probe = (file: string, ext = path.extname(file).slice(1), maxMinutes = 180) => probeVideo(file, { demuxer: demuxerOf(ext), maxMinutes });

describe('demuxerOf', () => {
  it('ép bộ tách theo đuôi', () => {
    expect(['mp4', 'm4v', 'mov', 'mkv', 'webm', 'avi', 'flv', 'MP4'].map(demuxerOf)).toEqual(['mov', 'mov', 'mov', 'matroska', 'matroska', 'avi', 'flv', 'mov']);
    expect(() => demuxerOf('m3u8')).toThrow();
  });
});

describe.skipIf(!ok)('probeVideo', () => {
  it('video thường: kích thước, tốc độ khung, thời lượng, luồng tiếng, phát được ở trình duyệt', async () => {
    const file = await make('plain.mp4', [...video(), ...tone(), ...x264, '-c:a', 'aac', '-shortest']);
    const m = await probe(file);
    expect(m).toMatchObject({ width: 320, height: 180, fps: 25, videoCodec: 'h264', audioCodec: 'aac', audioIndex: 1, audioStreams: 1, rotation: 0, hdr: false, matrix: 'bt601', browserPlayable: true });
    expect(m.durationMs).toBeGreaterThan(1900);
    expect(m.durationMs).toBeLessThan(2100);
    expect(Math.abs(m.audioStartMs)).toBeLessThan(50);
    expect(m.audioDurationMs).toBeGreaterThan(1800);
    expect(m.videoBitrate).toBeGreaterThan(1000);
  });

  it.each([
    ['mkv', ['-c:a', 'libopus'], 'opus', false],
    ['webm', ['-c:a', 'libopus'], 'opus', true],
    ['avi', ['-c:a', 'libmp3lame'], 'mp3', false],
    ['flv', ['-c:a', 'aac'], 'aac', false],
    ['mov', ['-c:a', 'pcm_s16le'], 'pcm_s16le', false],
  ])('.%s đọc được', async (ext, audio, codec, playable) => {
    const vcodec = ext === 'webm' ? ['-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8'] : ext === 'flv' ? ['-c:v', 'flv'] : x264;
    const m = await probe(await make(`c.${ext}`, [...video(), ...tone(), ...vcodec, ...audio, '-shortest']));
    expect(m).toMatchObject({ width: 320, height: 180, audioCodec: codec, browserPlayable: playable });
    expect(m.durationMs).toBeGreaterThan(1800);
    expect(m.audioDurationMs).toBeGreaterThan(1700);
  });

  it('cờ xoay 90°: kích thước hiển thị đổi chiều', async () => {
    const base = await make('base.mp4', [...video(), ...tone(), ...x264, '-c:a', 'aac', '-shortest']);
    await runFfmpeg(['-display_rotation', '90', '-i', base, '-c', 'copy', '-y', out('rotated.mp4')], null);
    expect(await probe(out('rotated.mp4'))).toMatchObject({ width: 180, height: 320, rotation: expect.any(Number) });
    expect([90, 270]).toContain((await probe(out('rotated.mp4'))).rotation);
  });

  it('điểm ảnh không vuông: kích thước hiển thị đã co về vuông', async () => {
    const file = await make('sar.mp4', [...video(), ...tone(), '-vf', 'setsar=2/1', ...x264, '-c:a', 'aac', '-shortest']);
    expect(await probe(file)).toMatchObject({ width: 640, height: 180 });
  });

  it('nhiều luồng tiếng: dùng luồng mặc định, không có cờ thì luồng đầu; tiếng bắt đầu muộn được ghi lại', async () => {
    const two = ['-map', '0:v', '-map', '1:a', '-map', '2:a', ...x264, '-c:a', 'aac'];
    const flagged = await make('two.mkv', [...video('320x180', 4), ...tone(4), ...tone(2, 900), ...two, '-disposition:a:0', '0', '-disposition:a:1', 'default']);
    expect(await probe(flagged)).toMatchObject({ audioStreams: 2, audioIndex: 2 });
    const unflagged = await make('two-plain.mkv', [...video('320x180', 4), ...tone(4), ...tone(2, 900), ...two, '-disposition:a:0', '0', '-disposition:a:1', '0']);
    expect(await probe(unflagged)).toMatchObject({ audioStreams: 2, audioIndex: 1 });
    const late = await make('late.mp4', [...video('320x180', 4), '-itsoffset', '1.5', ...tone(2), '-map', '0:v', '-map', '1:a', ...x264, '-c:a', 'aac']);
    const m = await probe(late);
    expect(m.audioStartMs).toBeGreaterThan(1400);
    expect(m.audioStartMs).toBeLessThan(1600);
    expect(m.audioDurationMs).toBeGreaterThan(1800);
    expect(m.audioDurationMs).toBeLessThan(2200);
  });

  it('HDR được nhận ra; SD không gắn thẻ dùng ma trận BT.601, HD dùng BT.709', async () => {
    const hdr = await make('hdr.mp4', [...video(), ...tone(), '-vf', 'setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc', ...x264, '-c:a', 'aac', '-shortest']);
    expect(await probe(hdr)).toMatchObject({ hdr: true });
    const hd = await make('hd.mp4', [...video('1280x720', 1), ...tone(1), ...x264, '-c:a', 'aac', '-shortest']);
    expect(await probe(hd)).toMatchObject({ hdr: false, matrix: 'bt709' });
  });

  it('không có tiếng, không có hình (kể cả chỉ có ảnh bìa) bị từ chối', async () => {
    await expect(probe(await make('mute.mp4', [...video(), ...x264]))).rejects.toBeInstanceOf(NoAudioStreamError);
    await expect(probe(await make('sound.mp4', [...tone(), '-c:a', 'aac']))).rejects.toBeInstanceOf(NoVideoStreamError);
    const cover = await make('cover.png', ['-f', 'lavfi', '-i', 'color=red:s=64x64', '-frames:v', '1']);
    const art = await make('art.mp4', [...tone(), '-i', cover, '-map', '0:a', '-map', '1:v', '-c:a', 'aac', '-c:v', 'png', '-disposition:v:0', 'attached_pic']);
    await expect(probe(art)).rejects.toBeInstanceOf(NoVideoStreamError);
  });

  it('dài quá giới hạn và quá 4096×2304 bị từ chối', async () => {
    const file = await make('long.mp4', [...video('320x180', 2), ...tone(2), ...x264, '-c:a', 'aac', '-shortest']);
    await expect(probe(file, 'mp4', 1 / 60)).rejects.toBeInstanceOf(VideoTooLongError);
    const wide = await make('wide.mp4', [...video('4098x240', 1, 2), ...tone(1), ...x264, '-c:a', 'aac', '-shortest']);
    await expect(probe(wide)).rejects.toBeInstanceOf(VideoResolutionError);
    const tall = await make('tall.mp4', [...video('2306x2310', 1, 1), ...tone(1), ...x264, '-c:a', 'aac', '-shortest']);
    await expect(probe(tall)).rejects.toBeInstanceOf(VideoResolutionError);
    const edge = await make('edge.mp4', [...video('2304x4096', 1, 1), ...tone(1), ...x264, '-c:a', 'aac', '-shortest']);
    await expect(probe(edge)).resolves.toMatchObject({ width: 2304, height: 4096 });
  }, 60_000);

  it('tệp hỏng và tệp đổi đuôi là không đọc được', async () => {
    await writeFile(out('junk.mp4'), Buffer.alloc(50_000, 7));
    await expect(probe(out('junk.mp4'))).rejects.toBeInstanceOf(MediaUnreadableError);
    await writeFile(out('empty.mp4'), '');
    await expect(probe(out('empty.mp4'))).rejects.toBeInstanceOf(MediaUnreadableError);
    const mkv = await make('real.mkv', [...video(), ...tone(), ...x264, '-c:a', 'aac', '-shortest']);
    await expect(probe(mkv, 'mp4')).rejects.toBeInstanceOf(MediaUnreadableError);
  });

  it('tệp giả dạng danh sách phát không mở được kết nối mạng', async () => {
    let hits = 0;
    const server = http.createServer((_req, res) => {
      hits++;
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/seg.ts`;
    try {
      const lists = {
        'hls.mp4': `#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\n${url}\n#EXT-X-ENDLIST\n`,
        'hls.mkv': `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n${url}\n`,
        'concat.avi': `ffconcat version 1.0\nfile '${url}'\n`,
        'sdp.flv': `v=0\no=- 0 0 IN IP4 127.0.0.1\nc=IN IP4 127.0.0.1\nm=video 5004 RTP/AVP 96\n`,
      };
      for (const [name, body] of Object.entries(lists)) {
        await writeFile(out(name), body);
        await expect(probe(out(name))).rejects.toBeInstanceOf(MediaUnreadableError);
      }
      expect(hits).toBe(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
