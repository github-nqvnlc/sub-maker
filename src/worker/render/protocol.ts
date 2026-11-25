import type { OverlayConfig } from '../../lib/overlay/config';
import type { AppliedCue } from '../../lib/overlay/types';

/** Giao thức IPC giữa worker và tiến trình con dựng hình (overlay-engine §8). */

export type RenderTask = {
  type: 'render';
  cues: AppliedCue[];
  config: OverlayConfig;
  durationMs: number;
  audioPath: string | null;
  outPath: string;
  /** dừng sớm khi tệp lớn hơn mức này (chỗ còn lại trong hạn mức) */
  maxBytes: number;
  threads: number;
  fontDir: string;
};

export type ParentMessage = RenderTask | { type: 'cancel' };

export type RenderErrorCode = 'RENDER_FAILED' | 'QUOTA_EXCEEDED' | 'DISK_FULL' | 'AUDIO_UNREADABLE';

export type ChildMessage =
  | { type: 'progress'; frame: number; total: number }
  | { type: 'warning'; code: 'CUE_SHRUNK'; params: { count: number; cues: string } }
  | { type: 'warning'; code: 'MISSING_GLYPH'; params: { chars: string } }
  | { type: 'done'; bytes: number }
  | { type: 'error'; code: RenderErrorCode; detail: string };
