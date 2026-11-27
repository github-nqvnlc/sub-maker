import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '@/lib/db';
import { systemSettings, users, videoExports, videoJobs } from '@/lib/db/schema';
import { headObject, uploadFileMultipart } from '@/lib/storage/client';
import { storageKeys } from '@/lib/storage/keys';
import { DEFAULT_VIDEO_STYLE } from '@/lib/video/style';
import { stopBoss } from '@/worker/queues';
import { sweepStaleVideoExports } from '@/worker/sweeper';
import { runGenerateVoice } from '@/worker/jobs/generate-voice';
import { runRenderOverlay } from '@/worker/jobs/render-overlay';
import { startMockProvider } from '../../mock-provider/server';
import { startSonioxMock, type SonioxMock } from '../mocks/soniox-mock';
import { clearRateLimits, createAdmin, createUser, resetDb, type TestUser } from './helpers';
import { FAST_RENDER, fakeRender } from './overlay-fake-render';
import { createOverlayJob, makeVoice, overlayRow, uploadSrt } from './overlay-helpers';
import { putSonioxConfig } from './stt-helpers';
import {
  audioHash,
  audioStreamOf,
  beepTimes,
  createExportApi,
  exportRow,
  fakeBurn,
  flashTimes,
  grayFrame,
  probeFile,
  reviewJob,
  rowsDiff,
  runExport,
  until,
  videoStreamOf,
  withObject,
} from './video-export-helpers';
import { errorOf, grantVideo, videoJobRow, videoUsed } from './video-helpers';
import { videoLogKeys } from './video-pipeline-helpers';
import { makeTestVideo } from './video-media';
import { FAST, jobRow as voiceJobRow, newProject, putGlobalConfig, startJob, uploadScript } from './voice-helpers';

/** Xuất video gắn cứng phụ đề bằng ffmpeg thật (spec 006, T072; FR-037, FR-042, FR-043, FR-049 đến FR-052, SC-008). */
let admin: TestUser;
let user: TestUser;
let projectId: string;
let mock: SonioxMock;
let tmp: string;

beforeAll(async () => {
  await resetDb();
  mock = await startSonioxMock();
  admin = await createAdmin();
  tmp = await mkdtemp(path.join(os.tmpdir(), 'render-src-'));
}, 60_000);
afterAll(async () => {
  await mock.close();
  await stopBoss();
  await rm(tmp, { recursive: true, force: true });
});
beforeEach(async () => {
  await clearRateLimits();
  await getDb().delete(videoExports);
  await getDb().delete(videoJobs);
  await getDb().update(users).set({ videoUsedBytes: 0 });
  await getDb().delete(systemSettings);
  mock.reset();
  await putSonioxConfig(admin, mock, 'ok', { enabled: true });
  user = await createUser();
  await grantVideo(admin, user.id);
  projectId = await newProject(user);
});

const ffmpeg = (args: string[]) => execFileSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-v', 'error', '-y', ...args]);
let n = 0;
/** Video thử dựng bằng tham số ffmpeg tùy ý. */
async function custom(ext: string, args: string[]): Promise<Buffer> {
  const file = path.join(tmp, `s${++n}.${ext}`);
  ffmpeg([...args, file]);
  return readFile(file);
}
const SIZE = { width: 640, height: 360 };
const plain = (seconds = 6) => makeTestVideo({ seconds, size: `${SIZE.width}x${SIZE.height}` });

async function exported(source: Buffer, fileName = 'phim.mp4') {
  const job = await reviewJob(user, projectId, source, fileName);
  const dto = await createExportApi(user, job.id);
  await runExport(dto.id);
  const row = (await exportRow(dto.id))!;
  return { job, row };
}
/** So thành phẩm với nguồn (đã lưu ra đĩa). */
async function compare<T>(source: Buffer, ext: string, key: string, fn: (src: string, out: string) => T): Promise<T> {
  const src = path.join(tmp, `cmp${++n}.${ext}`);
  await writeFile(src, source);
  return withObject(key, async (out) => fn(src, out));
}

describe('thành phẩm', () => {
  it('giữ kích thước, số khung, thời lượng và tiếng của nguồn; chữ hiện đúng mốc ở phần dưới khung', async () => {
    const source = await plain();
    const used = async () => videoUsed(user.id);
    const job = await reviewJob(user, projectId, source);
    const before = await used();
    const dto = await createExportApi(user, job.id);
    expect(dto).toMatchObject({ status: 'queued', progressPercent: 50, cueRevision: job.cueRevision });
    await runExport(dto.id);
    const row = (await exportRow(dto.id))!;
    expect(row).toMatchObject({ status: 'completed', progressPercent: 100, errorCode: null, heartbeatAt: null });
    expect(row.outputKey).toBe(storageKeys.videoExport(user.id, job.id, row.id, 'mp4', 1));
    expect((await headObject(row.outputKey!))!.size).toBe(row.outputBytes);
    expect(await used()).toBe(before + row.outputBytes!);
    expect(Math.abs(row.expiresAt!.getTime() - row.finishedAt!.getTime() - 7 * 24 * 3600_000)).toBeLessThan(1000);
    const after = (await videoJobRow(job.id))!;
    expect(Math.abs(after.sourceExpiresAt!.getTime() - row.finishedAt!.getTime() - 48 * 3600_000)).toBeLessThan(1000);
    expect(await videoLogKeys(job.id)).toEqual(expect.arrayContaining(['exportQueued', 'exportStarted', 'exportRendering', 'exportRendered', 'exportUploading', 'exportCompleted']));

    await compare(source, 'mp4', row.outputKey!, (src, out) => {
      const a = probeFile(src);
      const b = probeFile(out);
      expect(videoStreamOf(b)).toMatchObject({ codec_name: 'h264', pix_fmt: 'yuv420p', ...SIZE });
      expect(videoStreamOf(b).nb_read_packets).toBe(videoStreamOf(a).nb_read_packets);
      expect(Math.abs(Number(b.format.duration) - Number(a.format.duration))).toBeLessThanOrEqual(0.1);
      expect(audioStreamOf(b).codec_name).toBe('aac');
      expect(audioHash(out)).toBe(audioHash(src));
      // 0,6 giây: cue đầu đang hiện ở phần dưới; phần trên không đổi. 1,5 giây: khoảng trống, không có chữ
      const at = (file: string, s: number) => grayFrame(file, s, SIZE.width, SIZE.height);
      const band = (s: number, from: number, to: number) => rowsDiff(at(src, s), at(out, s), SIZE.width, from, to);
      // dòng chữ cỡ 16 px quanh độ cao 85% (hàng 306)
      expect(band(0.6, 298, 315)).toBeGreaterThan(6);
      expect(band(0.6, 0, 180)).toBeLessThan(4);
      expect(band(1.5, 298, 315)).toBeLessThan(4);
    });
  }, 90_000);

  it('nhiều luồng tiếng: dịch và xuất theo luồng mặc định của tệp, thành phẩm giữ đúng luồng đó', async () => {
    const source = await custom('mp4', [
      '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=25:d=6', '-f', 'lavfi', '-i', 'sine=frequency=300:d=6', '-f', 'lavfi', '-i', 'sine=frequency=1500:d=6',
      '-map', '0:v', '-map', '1:a', '-map', '2:a', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-disposition:a:0', '0', '-disposition:a:1', 'default',
    ]);
    const { job, row } = await exported(source);
    expect(job.media).toMatchObject({ audioStreams: 2, audioIndex: 2, audioNumber: 2 });
    expect(await videoLogKeys(job.id)).toContain('audioStream');
    await compare(source, 'mp4', row.outputKey!, (src, out) => {
      expect(probeFile(out).streams.filter((s) => s.codec_type === 'audio')).toHaveLength(1);
      const streamHash = (file: string, map: string) => ffmpeg(['-i', file, '-map', map, '-c', 'copy', '-f', 'md5', '-']).toString('utf8').trim();
      expect(streamHash(out, '0:a:0')).toBe(streamHash(src, '0:a:1'));
    });
  }, 90_000);

  it('video có cờ xoay: thành phẩm đúng chiều, không còn cờ', async () => {
    const flat = await custom('mp4', ['-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=25:d=6', '-f', 'lavfi', '-i', 'sine=d=6', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac']);
    const flatFile = path.join(tmp, 'flat.mp4');
    await writeFile(flatFile, flat);
    const turned = await custom('mp4', ['-display_rotation', '90', '-i', flatFile, '-c', 'copy']);
    const { row } = await exported(turned);
    expect(row.status).toBe('completed');
    await withObject(row.outputKey!, async (out) => {
      const v = videoStreamOf(probeFile(out));
      expect([v.width, v.height]).toEqual([360, 640]);
      expect(v.side_data_list?.find((d) => d.rotation !== undefined)).toBeUndefined();
    });
  }, 90_000);

  it.each([
    ['.mkv tiếng Opus được chuyển AAC', 'mkv', ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'libopus'], 'aac'],
    ['.avi MPEG-4 giữ tiếng MP3', 'avi', ['-c:v', 'mpeg4', '-q:v', '5', '-c:a', 'libmp3lame'], 'mp3'],
    ['.flv tiếng AAC', 'flv', ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac'], 'aac'],
  ])('%s', async (_name, ext, codecs, audio) => {
    const source = await custom(ext, ['-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=25:d=6', '-f', 'lavfi', '-i', 'sine=d=6', ...codecs]);
    const { row } = await exported(source, `phim.${ext}`);
    expect(row.status).toBe('completed');
    await compare(source, ext, row.outputKey!, (src, out) => {
      expect(videoStreamOf(probeFile(out))).toMatchObject({ codec_name: 'h264', ...SIZE });
      expect(videoStreamOf(probeFile(out)).nb_read_packets).toBe(videoStreamOf(probeFile(src)).nb_read_packets);
      expect(audioStreamOf(probeFile(out)).codec_name).toBe(audio);
      expect(Math.abs(Number(probeFile(out).format.duration) - Number(probeFile(src).format.duration))).toBeLessThanOrEqual(0.1);
    });
  }, 90_000);

  it('HDR: cảnh báo trước khi xuất và chuyển về SDR BT.709', async () => {
    const source = await custom('mp4', ['-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=25:d=6', '-f', 'lavfi', '-i', 'sine=d=6', '-vf', 'setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac']);
    const job = await reviewJob(user, projectId, source);
    const estimate = await (await user.client.post(`/api/video/jobs/${job.id}/exports/estimate`, { json: {} })).json();
    expect(estimate).toMatchObject({ blocked: null, width: 640, height: 360 });
    expect(estimate.warnings.map((w: { code: string }) => w.code)).toContain('HDR');
    const dto = await createExportApi(user, job.id);
    await runExport(dto.id);
    const row = (await exportRow(dto.id))!;
    expect(row.status).toBe('completed');
    await withObject(row.outputKey!, async (out) => {
      expect(videoStreamOf(probeFile(out))).toMatchObject({ color_transfer: 'bt709', color_space: 'bt709', pix_fmt: 'yuv420p' });
    });
  }, 90_000);

  it.each([
    ['tốc độ khung hình cố định', []],
    ['tốc độ khung hình thay đổi', ['-vf', "select='not(between(n,30,70)*mod(n,3))'", '-fps_mode', 'vfr']],
  ])('chớp sáng và tiếng bíp cùng lúc ở đầu và cuối, %s: lệch không quá 50 ms', async (_name, extra) => {
    const flash = "drawbox=x=0:y=0:w=iw:h=ih/2:color=white:t=fill:enable='between(t,0.5,0.7)+between(t,5,5.2)'";
    const filters = extra.length ? ['-vf', `${flash},${extra[1]}`, ...extra.slice(2)] : ['-vf', flash];
    const source = await custom('mp4', [
      '-f', 'lavfi', '-i', 'color=c=black:s=640x360:r=25:d=6',
      '-f', 'lavfi', '-i', "aevalsrc='0.8*sin(2*PI*1000*t)*(between(t,0.5,0.7)+between(t,5,5.2))':s=48000:d=6",
      ...filters, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
    ]);
    const { row } = await exported(source);
    expect(row.status).toBe('completed');
    await compare(source, 'mp4', row.outputKey!, (src, out) => {
      expect(videoStreamOf(probeFile(out)).nb_read_packets).toBe(videoStreamOf(probeFile(src)).nb_read_packets);
      const flashes = flashTimes(out);
      const beeps = beepTimes(out);
      expect(flashes).toHaveLength(2);
      expect(beeps).toHaveLength(2);
      for (const [i, t] of flashes.entries()) expect(Math.abs(t - beeps[i]!)).toBeLessThanOrEqual(0.05);
    });
  }, 90_000);
});

describe('hiệu ứng trong thành phẩm (T122; FR-032, FR-033)', () => {
  /** Hộp bao các điểm ảnh thỏa điều kiện ở một thời điểm của thành phẩm. */
  function boxAt(file: string, seconds: number, pred: (r: number, g: number, b: number) => boolean) {
    const data = execFileSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-v', 'error', '-ss', String(seconds), '-i', file, '-frames:v', '1', '-vf', 'format=rgb24', '-f', 'rawvideo', '-'], { maxBuffer: 64 * 1024 * 1024 });
    let x0 = SIZE.width;
    let x1 = -1;
    let sum = 0;
    let count = 0;
    for (let i = 0; i < SIZE.width * SIZE.height; i++) {
      if (!pred(data[i * 3]!, data[i * 3 + 1]!, data[i * 3 + 2]!)) continue;
      const x = i % SIZE.width;
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      sum += x;
      count++;
    }
    return count === 0 ? null : { width: x1 - x0 + 1, centre: sum / count, count };
  }
  const red = (r: number, g: number, b: number) => r > 170 && g < 90 && b < 90;
  const white = (r: number, g: number, b: number) => r > 200 && g > 200 && b > 200;

  it('karaoke tô từ đang đọc chạy từ trái sang phải; hiệu ứng nảy phóng dần lúc đoạn mới hiện', async () => {
    const source = await custom('mp4', ['-f', 'lavfi', '-i', `color=c=0x008000:s=${SIZE.width}x${SIZE.height}:r=25:d=6`, '-f', 'lavfi', '-i', 'sine=frequency=600:duration=6', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac']);
    const job = await reviewJob(user, projectId, source);
    const style = { ...DEFAULT_VIDEO_STYLE, font: { family: 'be-vietnam-pro', size: 64, weight: 800 }, sync: 'karaoke', wordEffect: 'active', enter: 'bounce', effectMs: 500, highlightColor: '#FF0000', stroke: { enabled: false, color: '#000000', width: 4 } };
    expect((await user.client.put(`/api/video/jobs/${job.id}/style`, { json: style })).status).toBe(200);
    const dto = await createExportApi(user, job.id);
    await runExport(dto.id);
    const row = (await exportRow(dto.id))!;
    expect(row.status).toBe('completed');
    await withObject(row.outputKey!, async (out) => {
      // đoạn đầu 0,12–1,2 giây: từ được tô dịch sang phải
      const early = boxAt(out, 0.24, red)!;
      const late = boxAt(out, 1.04, red)!;
      expect(early.count).toBeGreaterThan(50);
      expect(late.centre).toBeGreaterThan(early.centre + SIZE.width * 0.1);
      // lúc mới hiện cả khối chữ (gồm từ đang tô) còn nhỏ hơn lúc đã đứng yên
      const text = (r: number, g: number, b: number) => red(r, g, b) || white(r, g, b);
      const entering = boxAt(out, 0.12, text)!;
      const settled = boxAt(out, 0.96, text)!;
      expect(entering.width).toBeLessThan(settled.width * 0.95);
      // khoảng trống giữa hai đoạn không có chữ
      expect(boxAt(out, 1.5, (r, g, b) => red(r, g, b) || white(r, g, b))).toBeNull();
    });
  }, 90_000);
});

describe('lỗi, hạn mức và phục hồi', () => {
  it('vượt chỗ còn lại: không lưu thành phẩm, không trừ hạn mức, không thử lại', async () => {
    const job = await reviewJob(user, projectId, await plain());
    const dto = await createExportApi(user, job.id);
    const used = await videoUsed(user.id);
    await getDb().insert(systemSettings).values({ key: 'userVideoQuotaBytes', value: used + 1000 }).onConflictDoUpdate({ target: systemSettings.key, set: { value: used + 1000 } });
    await runExport(dto.id);
    expect(await exportRow(dto.id)).toMatchObject({ status: 'failed', errorCode: 'QUOTA_EXCEEDED', outputKey: null });
    expect(await headObject(storageKeys.videoExport(user.id, job.id, dto.id, 'mp4', 1))).toBeNull();
    expect(await videoUsed(user.id)).toBe(used);
  }, 60_000);

  it('lỗi dựng hình hoặc kho lưu tệp được thử lại tối đa 3 lần', async () => {
    const job = await reviewJob(user, projectId, await plain());
    const first = await createExportApi(user, job.id);
    const flaky = fakeBurn({ outcomes: ['RENDER_FAILED', 'RENDER_STALLED', 'RENDER_FAILED', 'ok'] });
    await runExport(first.id, { spawnRender: flaky.spawn });
    expect(flaky.tasks).toHaveLength(4);
    expect(await exportRow(first.id)).toMatchObject({ status: 'completed' });

    const second = await createExportApi(user, job.id);
    let uploads = 0;
    await runExport(second.id, {
      spawnRender: fakeBurn().spawn,
      upload: async (...args) => {
        if (++uploads < 3) throw new Error('ECONNRESET');
        return uploadFileMultipart(...args);
      },
    });
    expect(uploads).toBe(3);
    expect(await exportRow(second.id)).toMatchObject({ status: 'completed' });

    const third = await createExportApi(user, job.id);
    const always = fakeBurn({ outcomes: ['RENDER_FAILED', 'RENDER_FAILED', 'RENDER_FAILED', 'RENDER_FAILED', 'RENDER_FAILED'] });
    await runExport(third.id, { spawnRender: always.spawn });
    expect(always.tasks).toHaveLength(4);
    expect(await exportRow(third.id)).toMatchObject({ status: 'failed', errorCode: 'RENDER_FAILED' });
  }, 60_000);

  it('tệp nguồn hỏng và hết đĩa: báo ngay, không thử lại', async () => {
    const job = await reviewJob(user, projectId, await plain());
    const broken = await createExportApi(user, job.id);
    let downloads = 0;
    await runExport(broken.id, {
      download: async (_key, file) => {
        downloads++;
        await writeFile(file, 'khong phai video');
      },
    });
    expect(downloads).toBe(1);
    expect(await exportRow(broken.id)).toMatchObject({ status: 'failed', errorCode: 'SOURCE_UNREADABLE' });
    const full = await createExportApi(user, job.id);
    await runExport(full.id, { freeBytes: async () => 1000 });
    expect(await exportRow(full.id)).toMatchObject({ status: 'failed', errorCode: 'DISK_FULL' });
  }, 60_000);

  it('tắt worker giữa lúc xuất: được đánh dấu gián đoạn, chạy lại hoàn tất; lượt cũ không đụng vào kết quả mới', async () => {
    const job = await reviewJob(user, projectId, await plain());
    const dto = await createExportApi(user, job.id);
    const hung = fakeBurn({ hold: true });
    const old = runExport(dto.id, { spawnRender: hung.spawn, heartbeatMs: 3_600_000 });
    await until(async () => hung.tasks.length === 1);
    await getDb()
      .update(videoExports)
      .set({ heartbeatAt: new Date(Date.now() - 120_000) })
      .where(eq(videoExports.id, dto.id));
    const queued: string[] = [];
    expect((await sweepStaleVideoExports({ render: async (id) => queued.push(id) })).interrupted).toEqual([dto.id]);
    expect(queued).toEqual([dto.id]);
    await runExport(dto.id);
    const done = (await exportRow(dto.id))!;
    expect(done.status).toBe('completed');
    hung.release();
    await old;
    expect(await exportRow(dto.id)).toMatchObject({ status: 'completed', outputBytes: done.outputBytes, outputKey: done.outputKey });
    expect((await headObject(done.outputKey!))!.size).toBe(done.outputBytes);
    expect(await headObject(storageKeys.videoExport(user.id, job.id, dto.id, 'mp4', 1))).toBeNull();
  }, 60_000);

  it('gián đoạn quá 3 lần thì báo lỗi; bản đang chờ bị mất khỏi hàng đợi được xếp lại', async () => {
    const job = await reviewJob(user, projectId, await plain());
    const dto = await createExportApi(user, job.id);
    const queued: string[] = [];
    const sweep = () => sweepStaleVideoExports({ render: async (id) => queued.push(id) });
    for (let i = 1; i <= 4; i++) {
      await getDb()
        .update(videoExports)
        .set({ status: 'running', heartbeatAt: new Date(Date.now() - 120_000) })
        .where(eq(videoExports.id, dto.id));
      const r = await sweep();
      expect(i <= 3 ? r.interrupted : r.failed).toEqual([dto.id]);
    }
    expect(await exportRow(dto.id)).toMatchObject({ status: 'failed', errorCode: 'INTERRUPTED' });

    const lost = await createExportApi(user, job.id);
    await getDb()
      .update(videoExports)
      .set({ createdAt: new Date(Date.now() - 3600_000), heartbeatAt: null })
      .where(eq(videoExports.id, lost.id));
    expect((await sweep()).requeued).toEqual([lost.id]);
  }, 60_000);

  it('dừng rồi chạy lại dùng đúng nội dung đã chốt, kể cả khi phụ đề đã được sửa sau đó', async () => {
    const job = await reviewJob(user, projectId, await plain());
    const dto = await createExportApi(user, job.id);
    const hung = fakeBurn({ hold: true });
    const running = runExport(dto.id, { spawnRender: hung.spawn });
    await until(async () => hung.tasks.length === 1);
    expect((await user.client.post(`/api/video/exports/${dto.id}/stop`)).status).toBe(200);
    await running;
    expect(hung.cancelled()).toBeGreaterThan(0);
    expect(await exportRow(dto.id)).toMatchObject({ status: 'stopped', errorCode: null, outputKey: null });

    const [firstCue] = (await (await user.client.get(`/api/video/jobs/${job.id}/cues`)).json()).cues;
    await user.client.post(`/api/video/jobs/${job.id}/cues/ops`, { json: { baseRevision: job.cueRevision, ops: [{ type: 'update', id: firstCue.id, patch: { targetText: 'Đã sửa sau khi xuất' } }] } });
    expect((await user.client.post(`/api/video/exports/${dto.id}/rerun`)).status).toBe(202);
    const again = fakeBurn();
    await runExport(dto.id, { spawnRender: again.spawn });
    expect(again.tasks[0]!.cues[0]!.text).toBe('Xin chào mọi người.');
    expect(await exportRow(dto.id)).toMatchObject({ status: 'completed', cueRevision: job.cueRevision });
  }, 60_000);

  it('thu hồi quyền giữa chừng: dừng, không để lại tệp', async () => {
    const job = await reviewJob(user, projectId, await plain());
    const dto = await createExportApi(user, job.id);
    const hung = fakeBurn({ hold: true });
    const running = runExport(dto.id, { spawnRender: hung.spawn });
    await until(async () => hung.tasks.length === 1);
    await grantVideo(admin, user.id, false);
    await running;
    expect(await exportRow(dto.id)).toMatchObject({ status: 'stopped', outputKey: null });
  }, 60_000);

  it('giới hạn xuất đồng thời: bản thứ hai chờ tới lượt; video overlay không bị chiếm chỗ (FR-052)', async () => {
    const job = await reviewJob(user, projectId, await plain());
    const other = await createUser();
    await grantVideo(admin, other.id);
    const otherJob = await reviewJob(other, await newProject(other), await plain());
    const a = await createExportApi(user, job.id);
    const b = await createExportApi(other, otherJob.id);
    const first = fakeBurn({ hold: true });
    const second = fakeBurn();
    const ra = runExport(a.id, { spawnRender: first.spawn });
    await until(async () => first.tasks.length === 1);
    const rb = runExport(b.id, { spawnRender: second.spawn });
    await until(async () => (await videoLogKeys(otherJob.id)).includes('waiting'));
    expect(second.tasks).toHaveLength(0);
    expect((await exportRow(b.id))!.status).toBe('queued');
    // hàng đợi và giới hạn riêng: tạo voice và video overlay vẫn bắt đầu và chạy xong trong lúc video đang xuất, đang chờ
    const provider = await startMockProvider();
    try {
      await putGlobalConfig(admin, provider);
      const started = Date.now();
      const voiceJob = await startJob(user, projectId, (await uploadScript(user, projectId, 'Một dòng đủ dài để đọc.')).id);
      await runGenerateVoice(voiceJob.id, FAST);
      expect((await voiceJobRow(voiceJob.id))!.status).toBe('completed');
      const fileId = await uploadSrt(user, projectId);
      const overlay = await createOverlayJob(user, projectId, { fileId, voiceId: (await makeVoice(user, projectId, fileId)).voiceId });
      await runRenderOverlay(overlay.id, { ...FAST_RENDER, spawnRender: fakeRender().spawn });
      expect((await overlayRow(overlay.id))!.status).toBe('completed');
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally {
      await provider.close();
    }
    first.release();
    await Promise.all([ra, rb]);
    expect((await exportRow(b.id))!.status).toBe('completed');
  }, 90_000);
});

describe('lớp phụ đề riêng (T131; US10, FR-041)', () => {
  const sampleRgba = (file: string, seconds: number) =>
    execFileSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-v', 'error', '-ss', String(seconds), '-i', file, '-frames:v', '1', '-vf', 'format=rgba', '-f', 'rawvideo', '-'], {
      maxBuffer: 64 * 1024 * 1024,
    });

  const countPixels = (buf: Buffer, w: number, y0: number, y1: number, pred: (r: number, g: number, b: number, a: number) => boolean) => {
    let n = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        if (pred(buf[i]!, buf[i + 1]!, buf[i + 2]!, buf[i + 3]!)) n++;
      }
    }
    return n;
  };

  it('xuất .mp4 phông xanh (#00FF00) đúng kích thước, thời lượng nguồn, không tiếng, cộng hạn mức và giữ 7 ngày', async () => {
    const source = await plain();
    const job = await reviewJob(user, projectId, source);
    const before = await videoUsed(user.id);
    const est = await (await user.client.post(`/api/video/jobs/${job.id}/exports/estimate`, { json: { kind: 'layer', format: 'mp4' } })).json();
    expect(est).toMatchObject({ blocked: null, width: SIZE.width, height: SIZE.height });

    const createRes = await user.client.post(`/api/video/jobs/${job.id}/exports`, { json: { kind: 'layer', format: 'mp4', baseRevision: job.cueRevision } });
    expect(createRes.status).toBe(201);
    const dto = (await createRes.json()) as { id: string; kind: string; format: string };
    expect(dto).toMatchObject({ kind: 'layer', format: 'mp4' });

    await runExport(dto.id);
    const row = (await exportRow(dto.id))!;
    expect(row).toMatchObject({ status: 'completed', kind: 'layer', format: 'mp4', progressPercent: 100 });
    expect(row.outputKey).toBe(storageKeys.videoExport(user.id, job.id, row.id, 'mp4', 1));
    expect(await videoUsed(user.id)).toBe(before + row.outputBytes!);
    expect(Math.abs(row.expiresAt!.getTime() - row.finishedAt!.getTime() - 7 * 24 * 3600_000)).toBeLessThan(1000);

    await compare(source, 'mp4', row.outputKey!, (src, out) => {
      const a = probeFile(src);
      const b = probeFile(out);
      expect(videoStreamOf(b)).toMatchObject({ codec_name: 'h264', pix_fmt: 'yuv420p', ...SIZE });
      expect(b.streams.filter((s) => s.codec_type === 'audio')).toHaveLength(0);
      expect(Math.abs(Number(b.format.duration) - Number(a.format.duration))).toBeLessThanOrEqual(0.1);
      // 0,6 giây: vùng trên xanh lá (#00FF00), dải dưới có chữ trắng; 1,5 giây: toàn khung xanh lá
      const active = sampleRgba(out, 0.6);
      const blank = sampleRgba(out, 1.5);
      const isGreen = (r: number, g: number, b: number) => g > 200 && r < 40 && b < 40;
      const isWhite = (r: number, g: number, b: number) => r > 200 && g > 200 && b > 200;
      expect(countPixels(active, SIZE.width, 0, 150, isGreen)).toBeGreaterThan(SIZE.width * 140);
      expect(countPixels(active, SIZE.width, 280, 340, isWhite)).toBeGreaterThan(40);
      expect(countPixels(blank, SIZE.width, 0, SIZE.height, isWhite)).toBe(0);
    });
  }, 90_000);

  it('xuất .mov nền trong suốt giữ kích thước nguồn bất kỳ (360×640), không tiếng, trả MIME quicktime', async () => {
    const flat = await custom('mp4', ['-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=25:d=6', '-f', 'lavfi', '-i', 'sine=d=6', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac']);
    const flatFile = path.join(tmp, 'layer-flat.mp4');
    await writeFile(flatFile, flat);
    const turned = await custom('mp4', ['-display_rotation', '90', '-i', flatFile, '-c', 'copy']);
    const job = await reviewJob(user, projectId, turned, 'doc.mp4');

    const est = await (await user.client.post(`/api/video/jobs/${job.id}/exports/estimate`, { json: { kind: 'layer', format: 'mov' } })).json();
    expect(est).toMatchObject({ blocked: null, width: 360, height: 640 });
    expect(est.estimatedBytes).toBeGreaterThan(1_200_000);
    expect(est.estimatedBytes).toBeLessThan(2_200_000);

    const createRes = await user.client.post(`/api/video/jobs/${job.id}/exports`, { json: { kind: 'layer', format: 'mov', baseRevision: job.cueRevision } });
    expect(createRes.status).toBe(201);
    const dto = (await createRes.json()) as { id: string };
    await runExport(dto.id);
    const row = (await exportRow(dto.id))!;
    expect(row).toMatchObject({ status: 'completed', kind: 'layer', format: 'mov' });
    expect(row.outputKey).toBe(storageKeys.videoExport(user.id, job.id, row.id, 'mov', 1));

    const dl = await user.client.get(`/api/video/exports/${row.id}/video`);
    expect(dl.status).toBe(200);
    expect(dl.headers.get('content-type')).toContain('video/quicktime');
    expect(dl.headers.get('content-disposition')).toContain('.mov');
    await dl.body?.cancel();

    await withObject(row.outputKey!, async (out) => {
      const b = probeFile(out);
      const vs = videoStreamOf(b);
      expect(vs).toMatchObject({ codec_name: 'prores', width: 360, height: 640 });
      expect(vs.pix_fmt).toMatch(/^yuva444p/);
      expect(b.streams.filter((s) => s.codec_type === 'audio')).toHaveLength(0);
      expect(Math.abs(Number(b.format.duration) - 6)).toBeLessThanOrEqual(0.1);
      const active = sampleRgba(out, 0.6);
      const blank = sampleRgba(out, 1.5);
      // vùng trên trong suốt (alpha = 0), vùng chữ ở ~85% (hàng 510..580) có alpha > 200; khoảng trống không có điểm ảnh đục
      expect(countPixels(active, 360, 0, 300, (_r, _g, _b, a) => a > 0)).toBe(0);
      expect(countPixels(active, 360, 500, 590, (_r, _g, _b, a) => a > 200)).toBeGreaterThan(40);
      expect(countPixels(blank, 360, 0, 640, (_r, _g, _b, a) => a > 0)).toBe(0);
    });
  }, 90_000);

  it('nền trong suốt quá overlayMaxMinutesTransparent báo VIDEO_LAYER_TOO_LONG (422); phông xanh vẫn được phép', async () => {
    const job = await reviewJob(user, projectId, await plain());
    await getDb()
      .update(videoJobs)
      .set({ media: { ...job.media!, durationMs: 120_000 } })
      .where(eq(videoJobs.id, job.id));
    await getDb()
      .insert(systemSettings)
      .values({ key: 'overlayMaxMinutesTransparent', value: 1 })
      .onConflictDoUpdate({ target: systemSettings.key, set: { value: 1 } });

    const est = await (await user.client.post(`/api/video/jobs/${job.id}/exports/estimate`, { json: { kind: 'layer', format: 'mov' } })).json();
    expect(est.blocked).toBe('VIDEO_LAYER_TOO_LONG');

    const failMov = await user.client.post(`/api/video/jobs/${job.id}/exports`, { json: { kind: 'layer', format: 'mov', baseRevision: job.cueRevision } });
    expect(failMov.status).toBe(422);
    expect(await errorOf(failMov)).toMatchObject({ code: 'VIDEO_LAYER_TOO_LONG' });

    const okMp4 = await user.client.post(`/api/video/jobs/${job.id}/exports`, { json: { kind: 'layer', format: 'mp4', baseRevision: job.cueRevision } });
    expect(okMp4.status).toBe(201);
  }, 60_000);

  it('tổ hợp loại/định dạng không hợp lệ (burn+mov, layer+webm) bị từ chối ở schema', async () => {
    const job = await reviewJob(user, projectId, await plain());
    expect((await errorOf(await user.client.post(`/api/video/jobs/${job.id}/exports`, { json: { kind: 'burn', format: 'mov', baseRevision: job.cueRevision } }))).code).toBe('VALIDATION');
    expect((await errorOf(await user.client.post(`/api/video/jobs/${job.id}/exports`, { json: { kind: 'layer', format: 'webm', baseRevision: job.cueRevision } }))).code).toBe('VALIDATION');
  });
});
