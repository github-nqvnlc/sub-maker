/** Kiểu dữ liệu dùng chung của bộ dựng hình video overlay (spec 005). Không phụ thuộc DOM, Node hay CSDL. */

/** Cue đã tính mốc áp dụng (overlay-engine §2). */
export type AppliedCue = {
  /** thứ tự trong các cue được hiện, bắt đầu từ 0 */
  i: number;
  startMs: number;
  endMs: number;
  /** lúc đọc xong: khoảng đọc của câu là [startMs, readEndMs) */
  readEndMs: number;
  text: string;
  /** mốc gốc: voice khớp mốc hay tệp phụ đề */
  origin: 'voice' | 'file';
};

export type OverlayWarning = { code: string; params?: Record<string, string | number> };

export type WordSpan = { text: string; startMs: number; endMs: number };
