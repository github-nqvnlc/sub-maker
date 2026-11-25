import { readdir } from 'node:fs/promises';
import os from 'node:os';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getDb } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { FPS, frameCount } from '@/lib/overlay/frames';
import type { Aspect, Background, OverlayConfig } from '@/lib/overlay/config';
import { runRenderOverlay } from '@/worker/jobs/render-overlay';
import { stopBoss } from '@/worker/queues';
import { clearRateLimits, createUser, resetDb, type TestUser } from './helpers';
import {
  createOverlayJob,
  frameAt,
  makeVoice,
  overlayConfig,
  overlayLogKeys,
  overlayRow,
  postOverlayJob,
  probeVideo,
  px,
  TIMED_TIMELINE,
  uploadSrt,
  usedBytes,
  VOICE_MS,
  whitePixels,
  withVideo,
} from './overlay-helpers';
import { newProject } from './voice-helpers';

/** Xuất video THẬT bằng tiến trình con + ffmpeg (spec 005, T030 và các mở rộng theo từng user story). Nguồn 10 giây. */
let user: TestUser;
let projectId: string;
let fileId: string;
let voiceId: string;

beforeAll(async () => {
  await resetDb();
  await clearRateLimits();
  user = await createUser();
  projectId = await newProject(user);
  fileId = await uploadSrt(user, projectId);
  voiceId = (await makeVoice(user, projectId, fileId)).voiceId;
}, 60_000);
afterAll(async () => {
  await stopBoss();
});

async function exportVideo(over: Partial<OverlayConfig> = {}) {
  const job = await createOverlayJob(user, projectId, { fileId, voiceId, config: overlayConfig(over) });
  await runRenderOverlay(job.id, { heartbeatMs: 200 });
  const row = (await overlayRow(job.id))!;
  if (row.status !== 'completed') throw new Error(`xuất lỗi: ${row.status} ${row.errorCode} ${(await overlayLogKeys(job.id)).join(',')}`);
  return job.id;
}
/** khung đầu tiên mà thời điểm đại diện ≥ mốc */
const frameFrom = (ms: number) => Math.max(0, Math.ceil((ms * FPS) / 1000 - 0.5));

describe('xuất .mp4 phông màu', () => {
  it.each([
    ['9:16', 1080, 1920],
    ['16:9', 1920, 1080],
    ['1:1', 1080, 1080],
  ] as Array<[Aspect, number, number]>)('%s: đúng kích thước, 30 hình/giây, thời lượng bằng voice, có tiếng', async (aspect, w, h) => {
    const id = await exportVideo({ aspect });
    const row = (await overlayRow(id))!;
    expect(row).toMatchObject({ status: 'completed', progressPercent: 100, width: w, height: h });
    await withVideo(id, async (file) => {
      const i = await probeVideo(file);
      expect(i).toMatchObject({ width: w, height: h, fps: 30, codec: 'h264', pixFmt: 'yuv420p', audio: 'aac' });
      expect(i.frames).toBe(frameCount(VOICE_MS));
      expect(Math.abs(i.durationMs - VOICE_MS)).toBeLessThanOrEqual(50);
    });
    expect(await overlayLogKeys(id)).toEqual(expect.arrayContaining(['queued', 'started', 'rendering', 'rendered', 'uploading', 'completed']));
  }, 120_000);

  it.each([
    ['green', [0, 255, 0]],
    ['blue', [0, 0, 255]],
    ['black', [0, 0, 0]],
  ] as Array<[Background, number[]]>)('phông %s: màu nền đồng nhất (lệch ≤ 4 mức mỗi kênh) khi có và không có chữ', async (background, rgb) => {
    const id = await exportVideo({ background, stroke: { enabled: background !== 'black', color: '#000000', width: 6 } });
    await withVideo(id, async (file) => {
      const i = await probeVideo(file);
      for (const f of [0, frameFrom(2000)]) {
        const rgba = await frameAt(file, f, i);
        // ngoài vùng chữ (nửa trên khung hình)
        for (let y = 5; y < 900; y += 45) {
          for (let x = 5; x < 1080; x += 53) {
            const p = px(rgba, i.width, x, y);
            for (let c = 0; c < 3; c++) expect(Math.abs(p[c]! - rgb[c]!)).toBeLessThanOrEqual(4);
          }
        }
      }
    });
  }, 120_000);

  it('mốc hiện/ẩn theo mốc đọc thật của voice: khung ngay trước và sau mốc đúng trạng thái (SC-002)', async () => {
    const id = await exportVideo();
    const { cues } = (await overlayRow(id))!;
    expect(cues.map((c) => c.startMs)).toEqual(TIMED_TIMELINE.map((t) => t.startMs));
    expect(cues.every((c) => c.origin === 'voice')).toBe(true);
    await withVideo(id, async (file) => {
      const i = await probeVideo(file);
      const white = async (f: number) => whitePixels(await frameAt(file, f, i));
      for (const c of cues) {
        expect(await white(frameFrom(c.startMs) - 1)).toBe(0);
        expect(await white(frameFrom(c.startMs))).toBeGreaterThan(500);
        expect(await white(frameFrom(c.endMs) - 1)).toBeGreaterThan(500);
        if (frameFrom(c.endMs) < i.frames) expect(await white(frameFrom(c.endMs))).toBe(0);
      }
    });
  }, 120_000);

  it('tắt tiếng thì video không có luồng âm thanh, thời lượng vẫn bằng voice', async () => {
    const id = await exportVideo({ includeAudio: false });
    await withVideo(id, async (file) => {
      const i = await probeVideo(file);
      expect(i.audio).toBeNull();
      expect(Math.abs(i.durationMs - VOICE_MS)).toBeLessThanOrEqual(50);
    });
  }, 120_000);

  it('thư mục tạm của worker được dọn sau khi xong', async () => {
    await exportVideo({ includeAudio: false });
    expect((await readdir(os.tmpdir())).filter((n) => n.startsWith(`submaker-overlay-${process.pid}-`))).toEqual([]);
  }, 120_000);

  it('cảnh báo cần đo chữ được ghi vào nhật ký, không chặn xuất', async () => {
    const srt = ['1', '00:00:00,000 --> 00:00:05,000', `${Array(600).fill('phượng').join(' ')} 中文`, ''].join('\n');
    const f = await uploadSrt(user, projectId, srt, 'dai.srt');
    const job = await createOverlayJob(user, projectId, { fileId: f, voiceId });
    expect(job.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(['OTHER_FILE', 'LENGTH_MISMATCH']));
    await runRenderOverlay(job.id, { heartbeatMs: 200 });
    expect((await overlayRow(job.id))!.status).toBe('completed');
    expect(await overlayLogKeys(job.id)).toEqual(expect.arrayContaining(['cueShrunk', 'missingGlyph', 'completed']));
  }, 120_000);
});

/** Số điểm ảnh thỏa điều kiện trong khung RGBA. */
function countWhere(rgba: Buffer, pred: (r: number, g: number, b: number, a: number) => boolean): number {
  let n = 0;
  for (let o = 0; o < rgba.length; o += 4) if (pred(rgba[o]!, rgba[o + 1]!, rgba[o + 2]!, rgba[o + 3]!)) n++;
  return n;
}
const isYellow = (r: number, g: number, b: number) => r > 190 && g > 170 && b < 90;
const NO_STROKE = { enabled: false, color: '#000000', width: 6 };

describe('hiệu ứng câu trong video (US3)', () => {
  it('bounce + slideDown: khung đầu nhỏ hơn lúc đứng yên, có lúc vượt cỡ, khung cuối mờ hẳn', async () => {
    const id = await exportVideo({ enter: 'bounce', exit: 'slideDown', effectMs: 400, intensity: 'high', includeAudio: false });
    const [c] = (await overlayRow(id))!.cues;
    await withVideo(id, async (file) => {
      const i = await probeVideo(file);
      const white = async (ms: number) => whitePixels(await frameAt(file, frameFrom(ms), i));
      const still = await white(c!.startMs + 1500);
      expect(await white(c!.startMs)).toBeLessThan(still * 0.8);
      expect(Math.abs((await white(c!.startMs + 2500)) - still)).toBeLessThan(still * 0.02);
      expect(whitePixels(await frameAt(file, frameFrom(c!.endMs) - 1, i))).toBeLessThan(still * 0.1);
      const sizes: number[] = [];
      for (const d of [100, 150, 200]) sizes.push(await white(c!.startMs + d));
      expect(Math.max(...sizes)).toBeGreaterThan(still * 1.02);
    });
  }, 120_000);
});

describe('theo từng từ và karaoke trong video (US4)', () => {
  it('karaoke: có từ nổi bật khi đang đọc, hết khoảng đọc thì không còn dù câu chưa ẩn', async () => {
    const id = await exportVideo({ sync: 'karaoke', wordEffect: 'active', includeAudio: false });
    const [c] = (await overlayRow(id))!.cues;
    expect(c!.readEndMs).toBeLessThan(c!.endMs - 100);
    await withVideo(id, async (file) => {
      const i = await probeVideo(file);
      const frame = (ms: number) => frameAt(file, frameFrom(ms), i);
      for (const ms of [c!.startMs + 200, c!.startMs + 2000, c!.readEndMs - 100]) expect(countWhere(await frame(ms), isYellow)).toBeGreaterThan(200);
      const after = await frame(c!.readEndMs + 70);
      expect(countWhere(after, isYellow)).toBe(0);
      expect(whitePixels(after)).toBeGreaterThan(500);
    });
  }, 120_000);

  it('theo từng từ: chữ tăng dần theo thứ tự đọc rồi ở lại tới hết câu', async () => {
    const id = await exportVideo({ sync: 'word', wordEffect: 'cut', includeAudio: false });
    const [c] = (await overlayRow(id))!.cues;
    await withVideo(id, async (file) => {
      const i = await probeVideo(file);
      const counts: number[] = [];
      for (const ms of [c!.startMs, c!.startMs + 1000, c!.startMs + 2000, c!.startMs + 3000, c!.endMs - 50]) counts.push(whitePixels(await frameAt(file, frameFrom(ms), i)));
      for (let k = 1; k < counts.length; k++) expect(counts[k]!).toBeGreaterThan(counts[k - 1]! * 0.99);
      expect(counts[0]!).toBeGreaterThan(50);
      expect(counts.at(-1)!).toBeGreaterThan(counts[0]! * 5);
    });
  }, 120_000);
});

describe('nền trong suốt (US7)', () => {
  const base = { background: 'transparent', includeAudio: true, stroke: NO_STROKE } as const;

  it.each([
    ['mov', 'prores', 'aac'],
    ['webm', 'vp9', 'opus'],
  ] as Array<[OverlayConfig['format'], string, string]>)('.%s giữ kênh trong suốt: ngoài chữ bằng 0, hộp 50%% trung gian đúng màu, chữ đặc, có tiếng', async (format, codec, audio) => {
    const id = await exportVideo({ ...base, format, box: { enabled: true, color: '#2040C0', radius: 16, opacity: 50 } });
    const [c] = (await overlayRow(id))!.cues;
    await withVideo(id, async (file) => {
      const i = await probeVideo(file);
      expect(i).toMatchObject({ width: 1080, height: 1920, fps: 30, codec, audio });
      expect(i.frames).toBe(frameCount(VOICE_MS));
      expect(Math.abs(i.durationMs - VOICE_MS)).toBeLessThanOrEqual(60);
      const rgba = await frameAt(file, frameFrom(c!.startMs + 1000), i);
      for (const [x, y] of [[5, 5], [540, 300], [1070, 1910], [540, 900]] as const) expect(px(rgba, i.width, x, y)[3]).toBeLessThanOrEqual(2);
      // hộp nền 50%: nhiều điểm ảnh có alpha khoảng 128 và đúng màu (không bị tối đi vì nhân alpha)
      const sum = [0, 0, 0];
      let n = 0;
      for (let o = 0; o < rgba.length; o += 4) {
        const a = rgba[o + 3]!;
        if (a < 118 || a > 138 || rgba[o + 2]! < 120 || rgba[o]! > 90) continue;
        n++;
        for (let k = 0; k < 3; k++) sum[k]! += rgba[o + k]!;
      }
      expect(n).toBeGreaterThan(10_000);
      [0x20, 0x40, 0xc0].forEach((want, k) => expect(Math.abs(sum[k]! / n - want)).toBeLessThanOrEqual(12));
      expect(countWhere(rgba, (r, g, b, a) => a > 250 && r > 240 && g > 240 && b > 240)).toBeGreaterThan(2000);
      // khung không có câu: trong suốt hoàn toàn
      expect(countWhere(await frameAt(file, 0, i), (_r, _g, _b, a) => a > 2)).toBe(0);
    });
  }, 180_000);

  it('.mov: bóng mờ có alpha trung gian, mép chữ trắng không bị viền đen', async () => {
    const id = await exportVideo({ ...base, format: 'mov', includeAudio: false, shadow: { enabled: true, color: '#FF0000', blur: 20 } });
    const [c] = (await overlayRow(id))!.cues;
    await withVideo(id, async (file) => {
      const i = await probeVideo(file);
      const rgba = await frameAt(file, frameFrom(c!.startMs + 1000), i);
      expect(countWhere(rgba, (r, g, b, a) => a > 20 && a < 200 && r > 180 && g < 90 && b < 90)).toBeGreaterThan(2000);
      expect(countWhere(rgba, (r, g, b, a) => a > 60 && r < 60 && g < 60 && b < 60)).toBe(0);
    });
    const plain = await exportVideo({ ...base, format: 'mov', includeAudio: false });
    await withVideo(plain, async (file) => {
      const i = await probeVideo(file);
      const rgba = await frameAt(file, frameFrom(c!.startMs + 1000), i);
      let n = 0;
      let sum = 0;
      for (let o = 0; o < rgba.length; o += 4) {
        const a = rgba[o + 3]!;
        if (a < 60 || a > 200) continue;
        n++;
        sum += (rgba[o]! + rgba[o + 1]! + rgba[o + 2]!) / 3;
      }
      expect(n).toBeGreaterThan(200);
      expect(sum / n).toBeGreaterThan(200);
    });
  }, 180_000);

  it('ước tính .mov vượt chỗ còn lại → 409, trong khi .mp4 vẫn xuất được', async () => {
    const used = await usedBytes(user.id);
    const quota = 500 * 1024 * 1024;
    await getDb().update(users).set({ storageUsedBytes: quota - 20 * 1024 * 1024 }).where(eq(users.id, user.id));
    const mov = await postOverlayJob(user, projectId, { fileId, voiceId, config: overlayConfig({ ...base, format: 'mov' }) });
    expect(mov.status).toBe(409);
    const err = ((await mov.json()) as { error: { code: string; fields: Record<string, string> } }).error;
    expect(err.code).toBe('QUOTA_EXCEEDED');
    expect(Number(err.fields.estimateBytes)).toBeGreaterThan(Number(err.fields.remainingBytes));
    const mp4 = await postOverlayJob(user, projectId, { fileId, voiceId });
    expect(mp4.status).toBe(201);
    const { id } = (await mp4.json()) as { id: string };
    await user.client.post('/api/overlay/jobs/bulk-delete', { json: { ids: [id] } });
    await getDb().update(users).set({ storageUsedBytes: used }).where(eq(users.id, user.id));
  });
});

describe('hiệu ứng điện ảnh trong video (US8)', () => {
  it('blurIn: khung đầu nhòe hơn khung đứng yên', async () => {
    const id = await exportVideo({ enter: 'blurIn', effectMs: 400, includeAudio: false, background: 'black', stroke: NO_STROKE });
    const [c] = (await overlayRow(id))!.cues;
    await withVideo(id, async (file) => {
      const i = await probeVideo(file);
      const soft = await frameAt(file, frameFrom(c!.startMs + 100), i);
      const still = await frameAt(file, frameFrom(c!.startMs + 1500), i);
      const gray = (f: Buffer) => countWhere(f, (r, g, b) => r + g + b > 60 && r + g + b < 600);
      expect(gray(soft)).toBeGreaterThan(gray(still) * 1.5);
      expect(whitePixels(soft)).toBeLessThan(whitePixels(still));
    });
  }, 120_000);

  it('glitch trên nền trong suốt: tách màu trong 0,1 giây đầu rồi về chữ thường, vẫn trong suốt ngoài chữ', async () => {
    const id = await exportVideo({ enter: 'glitch', background: 'transparent', format: 'webm', includeAudio: false, stroke: NO_STROKE });
    const [c] = (await overlayRow(id))!.cues;
    await withVideo(id, async (file) => {
      const i = await probeVideo(file);
      const red = (f: Buffer) => countWhere(f, (r, g, b, a) => a > 150 && r > 150 && g < 100 && b < 130);
      const first = await frameAt(file, frameFrom(c!.startMs), i);
      const later = await frameAt(file, frameFrom(c!.startMs + 200), i);
      expect(red(first)).toBeGreaterThan(500);
      expect(red(later)).toBeLessThan(red(first) * 0.1);
      for (const f of [first, later]) expect(px(f, i.width, 540, 300)[3]).toBeLessThanOrEqual(2);
    });
  }, 120_000);
});
