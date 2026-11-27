import { describe, expect, it } from 'vitest';
import {
  checkClientAudioCapability,
  CLIENT_AUDIO_TRANSCODE_THRESHOLD_BYTES,
  extensionOfFastVideo,
  selectAudioOutputPlan,
} from '@/lib/video/client-audio';
import { extractAudioInWorkerCore } from '@/lib/video/extract-audio-core';
import { makeTestVideo } from '../../integration/video-media';

describe('tách âm thanh trên máy người dùng (T127; research R8)', () => {
  it('chỉ cho phép .mp4, .m4v, .mov, .mkv, .webm; loại .avi và .flv về luồng máy chủ', () => {
    for (const ext of ['mp4', 'm4v', 'mov', 'mkv', 'webm']) {
      expect(extensionOfFastVideo(`phim.${ext.toUpperCase()}`)).toBe(ext);
      expect(checkClientAudioCapability(`video.${ext}`, { hasWorker: true, deviceMemory: 8, hardwareConcurrency: 8 })).toEqual({ ok: true });
    }
    for (const ext of ['avi', 'flv', 'wmv']) {
      expect(extensionOfFastVideo(`phim.${ext}`)).toBeNull();
      expect(checkClientAudioCapability(`video.${ext}`, { hasWorker: true, deviceMemory: 8, hardwareConcurrency: 8 })).toEqual({ ok: false, reason: 'unsupported_ext' });
    }
  });

  it('kiểm tra Worker, deviceMemory ≥ 4 hoặc hardwareConcurrency ≥ 4 khi thiếu deviceMemory', () => {
    expect(checkClientAudioCapability('a.mp4', { hasWorker: false, deviceMemory: 8, hardwareConcurrency: 8 })).toEqual({ ok: false, reason: 'no_worker' });
    expect(checkClientAudioCapability('a.mp4', { hasWorker: true, deviceMemory: 2, hardwareConcurrency: 8 })).toEqual({ ok: false, reason: 'low_memory' });
    expect(checkClientAudioCapability('a.mp4', { hasWorker: true, deviceMemory: 4, hardwareConcurrency: 2 })).toEqual({ ok: true });
    expect(checkClientAudioCapability('a.mp4', { hasWorker: true, hardwareConcurrency: 2 })).toEqual({ ok: false, reason: 'low_cpu' });
    expect(checkClientAudioCapability('a.mp4', { hasWorker: true, hardwareConcurrency: 4 })).toEqual({ ok: true });
  });

  it('chọn chép thẳng khi ≤ 150 MB hoặc chuyển mono 64 kbps khi vượt 150 MB / bộ mã không chép được', () => {
    expect(selectAudioOutputPlan({ codec: 'aac', estimatedBytes: 5_000_000, canEncodeAac: true, canEncodeOpus: true })).toEqual({
      mode: 'copy',
      ext: 'm4a',
      mime: 'audio/mp4',
    });
    expect(selectAudioOutputPlan({ codec: 'opus', estimatedBytes: 5_000_000, canEncodeAac: true, canEncodeOpus: true })).toEqual({
      mode: 'copy',
      ext: 'webm',
      mime: 'audio/webm',
    });
    expect(selectAudioOutputPlan({ codec: 'mp3', estimatedBytes: 5_000_000, canEncodeAac: true, canEncodeOpus: true })).toEqual({
      mode: 'copy',
      ext: 'mp3',
      mime: 'audio/mpeg',
    });
    // vượt 150 MB hoặc AC-3 -> chuyển sang mono 64 kbps
    expect(
      selectAudioOutputPlan({ codec: 'aac', estimatedBytes: CLIENT_AUDIO_TRANSCODE_THRESHOLD_BYTES + 1, canEncodeAac: true, canEncodeOpus: true }),
    ).toEqual({
      mode: 'transcode',
      codec: 'aac',
      ext: 'm4a',
      mime: 'audio/mp4',
      bitrate: 64_000,
      channels: 1,
    });
    expect(selectAudioOutputPlan({ codec: 'ac3', estimatedBytes: 5_000_000, canEncodeAac: false, canEncodeOpus: true })).toEqual({
      mode: 'transcode',
      codec: 'opus',
      ext: 'webm',
      mime: 'audio/webm',
      bitrate: 64_000,
      channels: 1,
    });
    expect(selectAudioOutputPlan({ codec: 'ac3', estimatedBytes: 5_000_000, canEncodeAac: false, canEncodeOpus: false })).toEqual({ mode: 'unsupported' });
  });

  it('trích được luồng tiếng AAC từ MP4 và Opus từ WebM bằng mediabunny; từ chối không có hình hoặc > 4096×2304', async () => {
    const mp4 = await makeTestVideo({ ext: 'mp4', seconds: 2, size: '320x180' });
    const resMp4 = await extractAudioInWorkerCore(new File([new Uint8Array(mp4)], 'demo.mp4', { type: 'video/mp4' }));
    expect(resMp4.ok).toBe(true);
    if (resMp4.ok) {
      expect(resMp4.ext).toBe('m4a');
      expect(resMp4.buffer.byteLength).toBeGreaterThan(0);
    }

    const webm = await makeTestVideo({ ext: 'webm', seconds: 2, size: '320x180' });
    const resWebm = await extractAudioInWorkerCore(new File([new Uint8Array(webm)], 'demo.webm', { type: 'video/webm' }));
    expect(resWebm).toMatchObject({ ok: true });
    if (resWebm.ok) {
      expect(resWebm.ext).toBe('webm');
      expect(resWebm.buffer.byteLength).toBeGreaterThan(0);
    }

    const audioOnly = await makeTestVideo({ ext: 'mp4', seconds: 2, video: false, audio: true });
    const resNoVideo = await extractAudioInWorkerCore(new File([new Uint8Array(audioOnly)], 'only-audio.mp4', { type: 'video/mp4' }));
    expect(resNoVideo).toEqual({ ok: false, reason: 'no_video' });

    const bigVideo = await makeTestVideo({ ext: 'mp4', seconds: 1, size: '4100x100' });
    const resBig = await extractAudioInWorkerCore(new File([new Uint8Array(bigVideo)], 'huge.mp4', { type: 'video/mp4' }));
    expect(resBig).toEqual({ ok: false, reason: 'resolution' });
  });
});
