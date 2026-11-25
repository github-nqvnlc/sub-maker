/**
 * Tạo các tệp mẫu để kiểm tay trong phần mềm dựng phim (spec 005, quickstart §6, T054 và T088): bằng bộ dựng hình thật, dài 10 giây,
 * kèm tiếng mẫu. Ghi vào tmp/overlay-samples (không đưa vào git).
 *
 *   npx tsx scripts/overlay-samples.ts
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_CONFIG, type OverlayConfig } from '../src/lib/overlay/config';
import { applyTiming } from '../src/lib/overlay/timing';
import { parseSrtCues } from '../src/lib/parsing/srt';
import { spawnRender } from '../src/worker/render/spawn-render';

const OUT = path.resolve('tmp/overlay-samples');
const DURATION_MS = 10_000;

const soft: Partial<OverlayConfig> = {
  background: 'transparent',
  stroke: { enabled: false, color: '#000000', width: 6 },
  shadow: { enabled: true, color: '#000000', blur: 24 },
  box: { enabled: true, color: '#1E40FF', radius: 24, opacity: 50 },
};
const SAMPLES: Array<{ name: string; config: Partial<OverlayConfig> }> = [
  { name: '1-phong-xanh-la.mp4', config: {} },
  { name: '2-trong-suot-prores.mov', config: { ...soft, format: 'mov' } },
  { name: '3-trong-suot.webm', config: { ...soft, format: 'webm' } },
];

async function main() {
  mkdirSync(OUT, { recursive: true });
  const fileCues = parseSrtCues(readFileSync('tests/fixtures/sample-10s.srt', 'utf8')).cues.map((c) => ({ startMs: c.startMs, endMs: c.endMs, text: c.text, speakable: c.speakable }));
  const { cues } = applyTiming({ fileCues, source: 'uploaded', voiceTimeline: null, voiceDurationMs: DURATION_MS });
  for (const s of SAMPLES) {
    const outPath = path.join(OUT, s.name);
    const r = await spawnRender(
      {
        type: 'render',
        cues,
        config: { ...structuredClone(DEFAULT_CONFIG), ...s.config },
        durationMs: DURATION_MS,
        audioPath: path.resolve('tests/fixtures/sample-10s.mp3'),
        outPath,
        maxBytes: 1024 ** 3,
        threads: 4,
        fontDir: path.resolve('public/fonts/overlay'),
      },
      {},
      { stallMs: 60_000 },
    ).done;
    if (!r.ok) throw new Error(`${s.name}: ${r.code} ${r.detail}`);
    console.log(`${s.name}: ${(r.bytes / 1048576).toFixed(2)} MB`);
  }
  // Tệp thử QuickTime Animation: quyết định có đổi .mov sang dạng này để nhỏ hơn hay không (research R5)
  const animation = path.join(OUT, '4-trong-suot-animation.mov');
  const ff = spawnSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-v', 'error', '-y', '-i', path.join(OUT, '2-trong-suot-prores.mov'), '-c:v', 'qtrle', '-pix_fmt', 'argb', '-c:a', 'copy', animation], { stdio: 'inherit' });
  if (ff.status !== 0) throw new Error('Không tạo được tệp Animation');
  console.log(`Xong: ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
