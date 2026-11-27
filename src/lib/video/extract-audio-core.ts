import {
  BlobSource,
  BufferTarget,
  canEncodeAudio,
  Conversion,
  Input,
  MATROSKA,
  MP3,
  MP4,
  Mp3OutputFormat,
  Mp4OutputFormat,
  Output,
  QTFF,
  WEBM,
  WebMOutputFormat,
  type AudioCodec,
  type InputFormat,
  type OutputFormat,
} from 'mediabunny';
import type { ClientAudioExtension } from './types';

/** Giới hạn và quy tắc tách âm thanh trên trình duyệt (spec 006, FR-003, FR-010, research R8). */
export const FAST_AUDIO_EXTENSIONS = ['mp4', 'm4v', 'mov', 'mkv', 'webm'] as const;
export const CLIENT_AUDIO_MAX_BYTES = 500 * 1024 * 1024;
export const CLIENT_AUDIO_TRANSCODE_THRESHOLD_BYTES = 150 * 1024 * 1024;
export const CLIENT_AUDIO_TIMEOUT_MS = 5 * 60_000;
export const MAX_VIDEO_LONG_SIDE = 4096;
export const MAX_VIDEO_SHORT_SIDE = 2304;

export type ClientAudioResult =
  | { ok: true; buffer: ArrayBuffer; ext: ClientAudioExtension; mime: string; startMs: number; durationMs: number }
  | { ok: false; reason: string };

export type AudioOutputPlan =
  | { mode: 'copy'; ext: ClientAudioExtension; mime: string }
  | { mode: 'transcode'; codec: 'aac' | 'opus'; ext: ClientAudioExtension; mime: string; bitrate: number; channels: number }
  | { mode: 'unsupported' };

export function extensionOfFastVideo(fileName: string): (typeof FAST_AUDIO_EXTENSIONS)[number] | null {
  const ext = /\.([a-z0-9]+)$/i.exec(fileName)?.[1]?.toLowerCase() ?? '';
  return (FAST_AUDIO_EXTENSIONS as readonly string[]).includes(ext) ? (ext as (typeof FAST_AUDIO_EXTENSIONS)[number]) : null;
}

export function selectAudioOutputPlan(p: { codec: AudioCodec | null; estimatedBytes: number; canEncodeAac: boolean; canEncodeOpus: boolean }): AudioOutputPlan {
  const mustTranscode = p.estimatedBytes > CLIENT_AUDIO_TRANSCODE_THRESHOLD_BYTES;
  if (!mustTranscode) {
    if (p.codec === 'aac') return { mode: 'copy', ext: 'm4a', mime: 'audio/mp4' };
    if (p.codec === 'mp3') return { mode: 'copy', ext: 'mp3', mime: 'audio/mpeg' };
    if (p.codec === 'opus' || p.codec === 'vorbis') return { mode: 'copy', ext: 'webm', mime: 'audio/webm' };
  }
  if (p.canEncodeAac) return { mode: 'transcode', codec: 'aac', ext: 'm4a', mime: 'audio/mp4', bitrate: 64_000, channels: 1 };
  if (p.canEncodeOpus) return { mode: 'transcode', codec: 'opus', ext: 'webm', mime: 'audio/webm', bitrate: 64_000, channels: 1 };
  return { mode: 'unsupported' };
}

function formatsFor(ext: (typeof FAST_AUDIO_EXTENSIONS)[number]): InputFormat[] {
  switch (ext) {
    case 'mp4':
    case 'm4v':
      return [MP4, QTFF];
    case 'mov':
      return [QTFF, MP4];
    case 'mkv':
      return [MATROSKA];
    case 'webm':
      return [WEBM];
  }
}

function outputFormatFor(ext: ClientAudioExtension): OutputFormat {
  if (ext === 'm4a' || ext === 'mp4') return new Mp4OutputFormat({ fastStart: 'in-memory' });
  if (ext === 'mp3') return new Mp3OutputFormat();
  return new WebMOutputFormat();
}

/**
 * Tách riêng luồng tiếng từ tệp video trên trình duyệt bằng `mediabunny` (đọc theo đoạn, không nạp cả tệp 10 GB vào RAM).
 * Mọi lỗi hoặc trường hợp không đủ điều kiện đều trả `{ ok: false, reason }`, không ném lỗi ra giao diện.
 */
export async function extractAudioInWorkerCore(file: File, opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<ClientAudioResult> {
  const ext = extensionOfFastVideo(file.name);
  if (!ext) return { ok: false, reason: 'unsupported_ext' };

  const timeoutMs = opts.timeoutMs ?? CLIENT_AUDIO_TIMEOUT_MS;
  let timedOut = false;
  let conversion: Conversion | null = null;
  const input = new Input({ formats: formatsFor(ext), source: new BlobSource(file) });

  const abortNow = () => {
    timedOut = true;
    void conversion?.cancel().catch(() => undefined);
    try {
      input.dispose();
    } catch {
      /* đã đóng */
    }
  };
  const timer = setTimeout(abortNow, timeoutMs);
  const onSignalAbort = () => abortNow();
  opts.signal?.addEventListener('abort', onSignalAbort, { once: true });

  try {
    if (opts.signal?.aborted) return { ok: false, reason: 'aborted' };
    if (!(await input.canRead())) return { ok: false, reason: 'unreadable' };
    const format = await input.getFormat().catch(() => null);
    if (!format || format === MP3) return { ok: false, reason: 'unsupported_format' };

    const videoTrack = await input.getPrimaryVideoTrack();
    if (!videoTrack) return { ok: false, reason: 'no_video' };
    const w = await videoTrack.getDisplayWidth();
    const h = await videoTrack.getDisplayHeight();
    if (!w || !h || Math.max(w, h) > MAX_VIDEO_LONG_SIDE || Math.min(w, h) > MAX_VIDEO_SHORT_SIDE) {
      return { ok: false, reason: 'resolution' };
    }

    const audioTrack = await input.getPrimaryAudioTrack();
    if (!audioTrack) return { ok: false, reason: 'no_audio' };

    const startSec = await audioTrack.getFirstTimestamp().catch(() => 0);
    const durSec = (await audioTrack.getDurationFromMetadata().catch(() => null)) ?? (await input.getDurationFromMetadata().catch(() => null)) ?? 0;
    const codec = await audioTrack.getCodec().catch(() => null);
    const metaBitrate = (await audioTrack.getAverageBitrate().catch(() => null)) ?? (await audioTrack.getBitrate().catch(() => null));
    const stats = metaBitrate ? null : await audioTrack.computePacketStats(128).catch(() => null);
    const bitrate = metaBitrate ?? stats?.averageBitrate ?? 0;
    const estimatedBytes = durSec > 0 && bitrate > 0 ? Math.ceil((bitrate / 8) * durSec) : file.size;

    const tryRun = async (plan: Exclude<AudioOutputPlan, { mode: 'unsupported' }>): Promise<ArrayBuffer | null> => {
      const target = new BufferTarget();
      const output = new Output({ format: outputFormatFor(plan.ext), target });
      conversion = await Conversion.init({
        input,
        output,
        tracks: 'primary',
        showWarnings: false,
        trim: plan.mode === 'copy' ? { start: startSec } : undefined,
        video: { discard: true },
        audio: plan.mode === 'copy' ? {} : { forceTranscode: true, codec: plan.codec, numberOfChannels: plan.channels, bitrate: plan.bitrate },
      });
      if (!conversion.isValid || conversion.utilizedTracks.length === 0) return null;
      await conversion.execute();
      return target.buffer;
    };

    const canAac = await canEncodeAudio('aac', { numberOfChannels: 1, bitrate: 64_000 }).catch(() => false);
    const canOpus = await canEncodeAudio('opus', { numberOfChannels: 1, bitrate: 64_000 }).catch(() => false);
    const plan = selectAudioOutputPlan({ codec, estimatedBytes, canEncodeAac: canAac, canEncodeOpus: canOpus });
    if (plan.mode === 'unsupported') return { ok: false, reason: 'unsupported_codec' };

    let chosen = plan;
    let buf = await tryRun(plan);
    if (!buf && plan.mode === 'copy') {
      const fallback = selectAudioOutputPlan({ codec: null, estimatedBytes: CLIENT_AUDIO_TRANSCODE_THRESHOLD_BYTES + 1, canEncodeAac: canAac, canEncodeOpus: canOpus });
      if (fallback.mode !== 'transcode') return { ok: false, reason: 'cannot_transcode' };
      chosen = fallback;
      buf = await tryRun(fallback);
    }

    if (timedOut) return { ok: false, reason: opts.signal?.aborted ? 'aborted' : 'timeout' };
    if (!buf || buf.byteLength === 0 || buf.byteLength > CLIENT_AUDIO_MAX_BYTES) return { ok: false, reason: 'invalid_size' };

    return {
      ok: true,
      buffer: buf,
      ext: chosen.ext,
      mime: chosen.mime,
      startMs: Math.round(Math.max(0, startSec) * 1000),
      durationMs: Math.round(Math.max(0, durSec) * 1000),
    };
  } catch (e) {
    if (timedOut) return { ok: false, reason: opts.signal?.aborted ? 'aborted' : 'timeout' };
    return { ok: false, reason: e instanceof Error ? e.message : 'extract_failed' };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onSignalAbort);
    try {
      input.dispose();
    } catch {
      /* đã đóng */
    }
  }
}
