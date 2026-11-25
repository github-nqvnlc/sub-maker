import { getDb, type Db } from '../db';
import { overlayJobLogs } from '../db/schema';
import type { vi } from '../i18n/vi';
import { redactDeep } from '../security/redact';

/** Nhật ký tiến trình xuất video (FR-039): lưu khóa i18n + tham số, dựng chữ theo ngôn ngữ người xem; không chứa bí mật hay đường dẫn nội bộ. */
export type OverlayLogKey = keyof typeof vi.overlay.log;
export type OverlayLogLevel = 'info' | 'warn' | 'error';

export async function appendOverlayLog(
  jobId: string,
  level: OverlayLogLevel,
  messageKey: OverlayLogKey,
  params?: Record<string, string | number>,
  db: Db = getDb(),
): Promise<void> {
  await db
    .insert(overlayJobLogs)
    .values({ jobId, level, messageKey, params: params ? redactDeep(params) : null })
    .catch(() => undefined); // job vừa bị xóa (khóa ngoại) → bỏ qua
}
