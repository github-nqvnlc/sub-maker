import { and, eq, lt, or, isNull, sql } from 'drizzle-orm';
import { getDb } from '../db';
import { users } from '../db/schema';
import { HttpError, notFound, unauthenticated } from '../api/errors';
import { getAuth } from './auth';

/**
 * Hợp đồng nội bộ về xác thực/phân quyền (Nguyên tắc I). Mọi Route Handler PHẢI đi qua đây:
 * - `requireUser(request)`: 401 nếu chưa đăng nhập; từ chối tài khoản không `active`.
 * - `requireAdmin(request)`: User thường nhận 404 (không lộ sự tồn tại của chức năng quản trị).
 * - `owner` luôn lấy từ phiên, KHÔNG bao giờ từ client.
 */

export type AuthUser = {
  id: string;
  email: string;
  name: string;
  bio: string | null;
  role: 'admin' | 'user';
  status: 'active' | 'banned' | 'deleting';
  canUseCustomAi: boolean;
  storageUsedBytes: number;
  avatarKey: string | null;
  lastActiveAt: Date | null;
};

const ACTIVE_TOUCH_MS = 60_000;

async function loadSessionUser(headers: Headers): Promise<AuthUser | null> {
  const session = await getAuth().api.getSession({ headers });
  if (!session?.user?.id) return null;
  // Nạp lại từ DB để trạng thái khóa/xóa/quyền có hiệu lực ngay, không phụ thuộc cache cookie.
  const [row] = await getDb().select().from(users).where(eq(users.id, session.user.id)).limit(1);
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    bio: row.bio,
    role: row.role,
    status: row.status,
    canUseCustomAi: row.canUseCustomAi,
    storageUsedBytes: row.storageUsedBytes,
    avatarKey: row.avatarKey,
    lastActiveAt: row.lastActiveAt,
  };
}

/** Cập nhật `last_active_at` tối đa 1 lần/phút (T048). */
async function touchActive(user: AuthUser): Promise<void> {
  const now = Date.now();
  if (user.lastActiveAt && now - user.lastActiveAt.getTime() < ACTIVE_TOUCH_MS) return;
  await getDb()
    .update(users)
    .set({ lastActiveAt: new Date(now) })
    .where(
      and(
        eq(users.id, user.id),
        or(isNull(users.lastActiveAt), lt(users.lastActiveAt, sql`now() - interval '60 seconds'`)),
      ),
    );
}

export async function getCurrentUser(headers: Headers): Promise<AuthUser | null> {
  const user = await loadSessionUser(headers);
  if (!user || user.status !== 'active') return null;
  return user;
}

export async function requireUser(request: Request): Promise<AuthUser> {
  const user = await loadSessionUser(request.headers);
  if (!user) throw unauthenticated();
  if (user.status !== 'active') throw new HttpError(403, 'ACCOUNT_DISABLED');
  void touchActive(user).catch(() => undefined);
  return user;
}

export async function requireAdmin(request: Request): Promise<AuthUser> {
  const user = await loadSessionUser(request.headers);
  if (!user) throw unauthenticated();
  if (user.status !== 'active' || user.role !== 'admin') throw notFound();
  void touchActive(user).catch(() => undefined);
  return user;
}
