import { getDb, type Db } from '../db';
import { videoJobLogs } from '../db/schema';
import type { vi } from '../i18n/vi';
import { redactDeep } from '../security/redact';

/**
 * Nhật ký tiến trình video (spec 006, data-model §1.6): lưu khóa i18n + tham số, dựng chữ theo ngôn ngữ người xem; đi qua
 * `redactDeep` nên không chứa khóa. Người gọi KHÔNG đưa URL ký hay đường dẫn máy chủ vào tham số.
 */
export type VideoLogKey = keyof typeof vi.video.log;
export type VideoLogLevel = 'info' | 'warn' | 'error';

export async function appendVideoLog(
  jobId: string,
  level: VideoLogLevel,
  messageKey: VideoLogKey,
  params?: Record<string, string | number>,
  opts: { exportId?: string; secrets?: readonly string[]; db?: Db } = {},
): Promise<void> {
  await (opts.db ?? getDb())
    .insert(videoJobLogs)
    .values({ jobId, exportId: opts.exportId, level, messageKey, params: params ? redactDeep(params, opts.secrets) : null })
    .catch(() => undefined); // việc hoặc bản xuất vừa bị xóa (khóa ngoại) → bỏ qua
}
