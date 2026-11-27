/**
 * Vùng bị giao diện của mạng xã hội che trên video dọc 9:16 (spec 006, FR-030). Số đo là MÔ PHỎNG GẦN ĐÚNG theo phần trăm khung: giao
 * diện thật đổi theo thiết bị và phiên bản ứng dụng, nên màn hình ghi rõ đây là ước chừng. Chỉ dùng cho khung xem trước, không bao giờ
 * đưa vào bộ vẽ hay video xuất ra.
 */
export const SAFE_PLATFORMS = ['tiktok', 'shorts', 'reels'] as const;
export type SafePlatform = (typeof SAFE_PLATFORMS)[number];

/** Hình chữ nhật theo phần trăm bề rộng và chiều cao khung. */
export type SafeZone = { x: number; y: number; width: number; height: number };

/** Mỗi mạng: thanh trên cùng, vùng chú thích ở đáy và cột nút bên phải. */
export const SAFE_ZONES: Record<SafePlatform, readonly SafeZone[]> = {
  tiktok: [
    { x: 0, y: 0, width: 100, height: 10 },
    { x: 0, y: 78, width: 100, height: 22 },
    { x: 85, y: 35, width: 15, height: 43 },
  ],
  shorts: [
    { x: 0, y: 0, width: 100, height: 8 },
    { x: 0, y: 80, width: 100, height: 20 },
    { x: 85, y: 42, width: 15, height: 38 },
  ],
  reels: [
    { x: 0, y: 0, width: 100, height: 12 },
    { x: 0, y: 76, width: 100, height: 24 },
    { x: 85, y: 48, width: 15, height: 28 },
  ],
};

/** Khung có tỉ lệ 9:16 (cho phép lệch do làm tròn kích thước). */
export const isVerticalFrame = (width: number, height: number): boolean => height > 0 && Math.abs(width / height - 9 / 16) < 0.02;

type Box = { x: number; y: number; width: number; height: number };

/** Khối (điểm ảnh của khung) có chồng lên vùng bị che nào không; chỉ chạm mép thì không tính. */
export function boxHitsZone(box: Box, frame: { width: number; height: number }, platform: SafePlatform): boolean {
  const slack = 0.5;
  return SAFE_ZONES[platform].some((z) => {
    const left = (z.x * frame.width) / 100;
    const top = (z.y * frame.height) / 100;
    const right = ((z.x + z.width) * frame.width) / 100;
    const bottom = ((z.y + z.height) * frame.height) / 100;
    return box.x + box.width > left + slack && box.x < right - slack && box.y + box.height > top + slack && box.y < bottom - slack;
  });
}
