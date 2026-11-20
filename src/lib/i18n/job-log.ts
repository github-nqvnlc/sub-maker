import { fmt } from './fmt';
import type { Locale } from './locale';
import type { Dict } from './types';

type LogLike = { code: string; message: string; meta?: Record<string, unknown> | null };

/**
 * Câu nhật ký hiển thị (spec 003, FR-022): nhật ký lưu câu tiếng Việt (dữ liệu vận hành, giữ nguyên lịch sử). Giao diện tiếng Việt
 * hiện câu đã lưu; ngôn ngữ khác dựng lại từ mẫu `dict.jobLog[code]` + `meta` khi có đủ giá trị, ngược lại hiện câu đã lưu.
 */
export function renderJobLog(dict: Dict, locale: Locale, log: LogLike): string {
  if (locale === 'vi') return log.message;
  const tpl = (dict.jobLog as Record<string, string | undefined>)[log.code];
  if (!tpl) return log.message;
  const m = log.meta ?? {};
  const vars: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(m)) if (typeof v === 'string' || typeof v === 'number') vars[k] = v;
  if (typeof m.idx === 'number') vars.n = m.idx + 1;
  if (typeof m.durationMs === 'number') vars.sec = (m.durationMs / 1000).toFixed(1);
  if (typeof m.from === 'number') vars.from1 = m.from + 1;
  if (typeof m.to === 'number') vars.to1 = m.to + 1;
  if (Array.isArray(m.blocked)) vars.count = m.blocked.length;
  const out = fmt(tpl, vars);
  return /\{\w+\}/.test(out) ? log.message : out;
}
