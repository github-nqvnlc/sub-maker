import { createHash } from 'node:crypto';
import type { TtsProviderType } from '../schemas/common';

/**
 * Khóa cache audio TỪNG ĐOẠN, THEO USER và theo nội dung (research R7, FR-017, Nguyên tắc IV):
 *   hash = sha256(userId | providerType | model | voice | speed | định dạng | văn bản NFC)
 * Tách riêng khỏi worker/pipeline/cache.ts để lớp API (ước tính) dùng được mà không nhập ffmpeg/MinIO.
 */
export type CacheKeyInput = {
  userId: string;
  providerType: TtsProviderType;
  model: string | null;
  voice: string;
  speed: number | null;
  text: string;
};

const FORMAT = 'pcm24k-mono-s16';

export function contentHash(i: CacheKeyInput): string {
  return createHash('sha256')
    .update([i.userId, i.providerType, i.model ?? '', i.voice, i.speed ?? 'default', FORMAT, i.text.normalize('NFC')].join('\u0000'), 'utf8')
    .digest('hex');
}
