/** Mốc của cue dạng chữ trong trình biên tập: `[giờ:]phút:giây.phần-nghìn` (spec 006, FR-023). Hàm thuần. */

export function formatCueTime(ms: number): string {
  const t = Math.max(0, Math.round(ms));
  const h = Math.floor(t / 3_600_000);
  const m = Math.floor(t / 60_000) % 60;
  const s = Math.floor(t / 1000) % 60;
  const two = (n: number) => String(n).padStart(2, '0');
  const tail = `${two(m)}:${two(s)}.${String(t % 1000).padStart(3, '0')}`;
  return h > 0 ? `${h}:${tail}` : tail;
}

/** Nhận cả dấu phẩy thập phân (kiểu SRT) và số giây đơn thuần; sai dạng trả `null`. */
export function parseCueTime(input: string): number | null {
  const parts = input.trim().replace(',', '.').split(':');
  if (parts.length > 3) return null;
  const last = parts.pop()!;
  if (!/^\d+(\.\d{1,3})?$/.test(last) || parts.some((p) => !/^\d+$/.test(p))) return null;
  const seconds = Number(last);
  const [minutes = 0, hours = 0] = parts.reverse().map(Number);
  // khi có phần đứng trước thì giây và phút phải dưới 60
  if ((parts.length > 0 && seconds >= 60) || (parts.length > 1 && minutes >= 60)) return null;
  return Math.round((hours * 3600 + minutes * 60 + seconds) * 1000);
}
