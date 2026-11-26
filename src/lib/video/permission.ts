import { eq } from 'drizzle-orm';
import { HttpError } from '../api/errors';
import { getDb, type Db } from '../db';
import { users } from '../db/schema';

/**
 * Quyền Dịch Video (spec 006, FR-008, research R14): Administrator luôn được; User cần Administrator bật. Dùng chung cho tạo việc,
 * tải phần, hoàn tất, dịch, xuất, chạy lại. Xem, sửa, tải về và xóa dữ liệu đã có KHÔNG cần quyền này.
 */
export type VideoPrincipal = { role: 'admin' | 'user'; canTranslateVideo: boolean };

export const mayTranslate = (u: VideoPrincipal): boolean => u.role === 'admin' || u.canTranslateVideo;

export function requireVideoPermission(user: VideoPrincipal): void {
  if (!mayTranslate(user)) throw new HttpError(403, 'VIDEO_NOT_ALLOWED');
}

/** Cho worker: đọc lại quyền từ CSDL (thu hồi, khóa hoặc xóa User có hiệu lực ngay giữa tiến trình). */
export async function userMayTranslate(userId: string, db: Db = getDb()): Promise<boolean> {
  const [row] = await db
    .select({ role: users.role, canTranslateVideo: users.canTranslateVideo, status: users.status })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return !!row && row.status === 'active' && mayTranslate(row);
}
