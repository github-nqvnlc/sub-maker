import { describe, expect, it } from 'vitest';
import { burnMaxrate, burnOutputSize, estimateBurn, overlayFps } from '@/lib/video/estimate';
import { burnArgs, type BurnEncodeInput } from '@/worker/render/ffmpeg-args';

/** Tham số ffmpeg gắn cứng (spec 006, T083; contracts/render-and-media.md §3; FR-037, FR-038). */

const input: BurnEncodeInput = {
  source: { path: '/tmp/src.mp4', demuxer: 'mov', audioIndex: 1, hdr: false, matrix: 'bt709', copyAudio: true },
  width: 1920,
  height: 1080,
  band: { y: 800, height: 272 },
  fps: 30,
  maxrate: 8_000_000,
  outPath: '/tmp/out.mp4',
  threads: 6,
};
const after = (args: string[], flag: string, from = 0) => args[args.indexOf(flag, from) + 1];

describe('burnArgs', () => {
  const args = burnArgs(input);

  it('nguồn đọc từ đĩa với bộ tách ép theo đuôi; lớp chữ là RGBA thô qua pipe đúng cỡ dải', () => {
    expect(args.join(' ')).toContain('-protocol_whitelist file -f mov -i /tmp/src.mp4');
    expect(args.join(' ')).toContain('-protocol_whitelist pipe -f rawvideo -pix_fmt rgba -s 1920x272 -r 30 -i pipe:0');
  });

  it('ghép đúng vị trí dải, alpha nhân sẵn, giữ mốc khung của nguồn', () => {
    expect(after(args, '-filter_complex')).toBe(
      '[0:v:0]scale=1920:1080:flags=bicubic,setsar=1[base];[1:v]scale=out_color_matrix=bt709:out_range=tv,format=yuva420p[sub];[base][sub]overlay=0:800:alpha=premultiplied:eof_action=pass[v]',
    );
    expect(after(args, '-fps_mode')).toBe('passthrough');
    expect(args.slice(args.indexOf('-map'), args.indexOf('-map') + 4)).toEqual(['-map', '[v]', '-map', '0:1']);
  });

  it('H.264 CRF 20 veryfast có trần bitrate; chép tiếng khi chép được, không thì AAC 192 kbps', () => {
    expect(args.join(' ')).toContain('-c:v libx264 -preset veryfast -crf 20 -maxrate 8000000 -bufsize 16000000 -pix_fmt yuv420p');
    expect(after(args, '-c:a')).toBe('copy');
    const re = burnArgs({ ...input, source: { ...input.source, copyAudio: false } });
    expect(re.join(' ')).toContain('-c:a aac -b:a 192k');
    expect(args.join(' ')).toContain('-movflags +faststart -map_metadata -1 -threads 6');
    expect(args.at(-1)).toBe('/tmp/out.mp4');
  });

  it('HDR được chuyển về SDR BT.709 trước khi ghép; nguồn BT.601 giữ ma trận màu', () => {
    const hdr = after(burnArgs({ ...input, source: { ...input.source, hdr: true, matrix: 'bt709' } }), '-filter_complex')!;
    expect(hdr).toContain('zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p,scale=1920:1080');
    const sd = burnArgs({ ...input, source: { ...input.source, matrix: 'bt601' } });
    expect(after(sd, '-filter_complex')).toContain('scale=out_color_matrix=bt601:out_range=tv');
    expect(after(sd, '-colorspace')).toBe('smpte170m');
    expect(after(args, '-colorspace')).toBe('bt709');
  });

  it('không có chữ nào của người dùng trong tham số', () => {
    expect(args.some((a) => /[À-ỹ]/.test(a))).toBe(false);
  });
});

describe('trần bitrate, kích thước và ước tính', () => {
  it.each([
    [1280, 720, 1_000_000, 4_000_000],
    [640, 360, 500_000, 4_000_000],
    [1920, 1080, 2_000_000, 8_000_000],
    [1080, 1920, 2_000_000, 8_000_000],
    [1920, 1080, 20_000_000, 26_000_000],
    [3840, 2160, 10_000_000, 24_000_000],
    [3840, 2160, 40_000_000, 52_000_000],
    [2560, 1440, 1_000_000, 16_000_000],
  ])('%i×%i nguồn %i → %i', (width, height, videoBitrate, expected) => {
    expect(burnMaxrate({ width, height, videoBitrate })).toBe(expected);
  });

  it('cạnh lẻ làm tròn xuống số chẵn', () => {
    expect(burnOutputSize({ width: 853, height: 481 })).toEqual({ width: 852, height: 480 });
    expect(burnOutputSize({ width: 1920, height: 1080 })).toEqual({ width: 1920, height: 1080 });
  });

  it('lớp chữ vẽ ở tốc độ khung của nguồn, tối đa 60', () => {
    expect(overlayFps(29.97)).toBe(29.97);
    expect(overlayFps(120)).toBe(60);
    expect(overlayFps(0)).toBe(30);
  });

  it('ước tính dung lượng = thời lượng × (trần + tiếng) / 8 × 1,05, kèm cảnh báo', () => {
    const media = { durationMs: 600_000, width: 1920, height: 1080, videoBitrate: 2_000_000, audioCodec: 'aac', hdr: false };
    const e = estimateBurn(media);
    expect(e.bytes).toBe(Math.ceil(600 * ((8_000_000 + 192_000) / 8) * 1.05));
    expect(e.seconds).toBeGreaterThan(60);
    expect(e.seconds).toBeLessThan(1200);
    expect(e.warnings).toEqual([]);
    expect(estimateBurn({ ...media, hdr: true, width: 1921 }).warnings.map((w) => w.code)).toEqual(['HDR', 'ROUNDED_SIZE']);
    expect(estimateBurn({ ...media, audioCodec: 'ac3' }).bytes).toBeGreaterThan(e.bytes);
  });
});
