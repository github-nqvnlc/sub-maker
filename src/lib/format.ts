/** Định dạng hiển thị dùng chung (ngày giờ, thời lượng, dung lượng) theo locale tiếng Việt. */

export const fmtDateTime = (iso: string | null | undefined): string => (iso ? new Date(iso).toLocaleString('vi-VN') : '');

export const fmtDate = (iso: string | null | undefined): string => (iso ? new Date(iso).toLocaleDateString('vi-VN') : '');

export function fmtDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
