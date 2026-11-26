import { fmt } from '../i18n/fmt';
import type { Dict } from '../i18n/types';

/** Dựng chữ từ mã lỗi và khóa nhật ký của dịch video theo ngôn ngữ người xem. */
export const videoErrorText = (t: Dict, code: string): string => (t.video.errors as Record<string, string>)[code] ?? t.video.errors.INTERNAL;

export function videoLogText(t: Dict, entry: { messageKey: string; params: Record<string, string | number> | null }): string {
  const params = { ...(entry.params ?? {}) };
  if (typeof params.reason === 'string') params.reason = videoErrorText(t, params.reason);
  return fmt((t.video.log as Record<string, string>)[entry.messageKey] ?? entry.messageKey, params);
}
