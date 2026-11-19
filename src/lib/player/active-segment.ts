/**
 * Tìm đoạn đang được đọc theo thời điểm phát (FR-027). Hàm thuần, dùng chung cho giao diện và kiểm thử.
 *
 * Quy ước:
 * - Trả về CHỈ SỐ trong mảng `timeline` (không phải `idx` của đoạn).
 * - Trong khoảng lặng giữa hai đoạn vẫn giữ đoạn VỪA ĐỌC XONG làm đoạn hiện tại (không nháy tắt),
 *   tới khi đoạn kế tiếp bắt đầu.
 * - Trước đoạn đầu → 0; sau đoạn cuối → đoạn cuối. Timeline rỗng → -1.
 */
export type TimelineSeg = { idx: number; startMs: number; endMs: number };

export function findActiveIndex(timeline: readonly TimelineSeg[], tMs: number): number {
  if (timeline.length === 0) return -1;
  let lo = 0;
  let hi = timeline.length - 1;
  // tìm đoạn CUỐI CÙNG có startMs <= tMs
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (timeline[mid]!.startMs <= tMs) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/** Thời điểm (giây) để tua tới đầu một đoạn. */
export const segmentStartSeconds = (seg: TimelineSeg): number => seg.startMs / 1000;
