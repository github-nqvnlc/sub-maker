import { and, desc, eq, ilike, or, sql, count } from 'drizzle-orm';
import { getDb } from '../db';
import { accounts, sessions, users } from '../db/schema';
import { HttpError, notFound } from '../api/errors';
import { getAuth } from '../auth/auth';
import { disablePersonalConfigs } from '../providers/config-service';
import { stopAllForUser } from '../jobs/control';
import { stopAllVideoForUser } from '../video/control';
import { enqueueDeleteUser } from '../../worker/queues';
import { toPage } from '../api/pagination';

/**
 * Thao tác quản trị tài khoản (FR-037). Administrator chỉ quản lý tài khoản và xem thống kê,
 * KHÔNG có đường nào đọc nội dung Project của User (Nguyên tắc I).
 */

export type AdminUserDto = {
  id: string;
  email: string;
  displayName: string;
  role: 'admin' | 'user';
  status: 'active' | 'banned' | 'deleting';
  canUseCustomAi: boolean;
  canTranslateVideo: boolean;
  createdAt: string;
  lastActiveAt: string | null;
};

type UserRow = typeof users.$inferSelect;

export function toAdminUser(row: UserRow): AdminUserDto {
  return {
    id: row.id,
    email: row.email,
    displayName: row.name,
    role: row.role,
    status: row.status,
    canUseCustomAi: row.canUseCustomAi,
    canTranslateVideo: row.canTranslateVideo,
    createdAt: row.createdAt.toISOString(),
    lastActiveAt: row.lastActiveAt?.toISOString() ?? null,
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function getTarget(userId: string): Promise<UserRow> {
  if (!UUID_RE.test(userId)) throw notFound();
  const [row] = await getDb().select().from(users).where(eq(users.id, userId)).limit(1);
  if (!row) throw notFound();
  return row;
}

/** Tài khoản admin cấp sẵn không bị khóa/xóa/đổi quyền qua giao diện. */
function assertManageable(target: UserRow) {
  if (target.role === 'admin') {
    throw new HttpError(409, 'CONFLICT', 'Không thể thao tác lên tài khoản Administrator.');
  }
}

export async function listUsers(opts: {
  q?: string;
  status?: 'active' | 'banned' | 'deleting';
  customAi?: boolean;
  page: number;
  pageSize: number;
}): Promise<{ items: AdminUserDto[]; total: number }> {
  const db = getDb();
  const conds = [];
  if (opts.q?.trim()) {
    const like = `%${opts.q.trim().replace(/[%_\\]/g, '\\$&')}%`;
    conds.push(
      or(
        ilike(users.email, like),
        sql`immutable_unaccent(lower(${users.name})) like immutable_unaccent(lower(${like}))`,
      ),
    );
  }
  if (opts.status) conds.push(eq(users.status, opts.status));
  if (opts.customAi !== undefined) conds.push(eq(users.canUseCustomAi, opts.customAi));
  const where = conds.length ? and(...conds) : undefined;
  const p = toPage(opts.page, opts.pageSize);

  const [{ total } = { total: 0 }] = await db.select({ total: count() }).from(users).where(where);
  const rows = await db.select().from(users).where(where).orderBy(desc(users.createdAt)).limit(p.pageSize).offset(p.offset);
  return { items: rows.map(toAdminUser), total: Number(total) };
}

async function revokeSessions(userId: string) {
  await getDb().delete(sessions).where(eq(sessions.userId, userId));
}

export async function updateUser(
  userId: string,
  patch: { status?: 'active' | 'banned'; canUseCustomAi?: boolean; canTranslateVideo?: boolean },
): Promise<AdminUserDto> {
  const target = await getTarget(userId);
  assertManageable(target);
  if (target.status === 'deleting') throw new HttpError(409, 'CONFLICT', 'Tài khoản đang được xóa.');

  const set: Partial<typeof users.$inferInsert> = { updatedAt: new Date() };
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.canUseCustomAi !== undefined) set.canUseCustomAi = patch.canUseCustomAi;
  if (patch.canTranslateVideo !== undefined) set.canTranslateVideo = patch.canTranslateVideo;
  await getDb().update(users).set(set).where(eq(users.id, userId));

  if (patch.status === 'banned') {
    await revokeSessions(userId);
    // khóa User thì dừng các tiến trình đang chờ/chạy của họ (dữ liệu được giữ)
    await stopAllForUser(userId);
  }
  // FR-044: không còn quyền dùng cấu hình riêng → vô hiệu (giữ lại) cấu hình riêng của User
  if (patch.canUseCustomAi === false) await disablePersonalConfigs(userId);
  // Spec 006, FR-008: thu hồi quyền Dịch Video dừng tiến trình đang chạy để không phát sinh thêm chi phí (dữ liệu đã có giữ nguyên)
  if (patch.canTranslateVideo === false && patch.status !== 'banned') await stopAllVideoForUser(userId);

  const [fresh] = await getDb().select().from(users).where(eq(users.id, userId));
  return toAdminUser(fresh!);
}

export async function resetUserPassword(userId: string, newPassword: string): Promise<void> {
  const target = await getTarget(userId);
  assertManageable(target);
  const ctx = await getAuth().$context;
  const hash = await ctx.password.hash(newPassword);
  const db = getDb();
  const [account] = await db
    .select()
    .from(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.providerId, 'credential')))
    .limit(1);
  if (account) {
    await db.update(accounts).set({ password: hash, updatedAt: new Date() }).where(eq(accounts.id, account.id));
  } else {
    await db.insert(accounts).values({ accountId: userId, providerId: 'credential', userId, password: hash });
  }
  await revokeSessions(userId);
}

/**
 * Bắt đầu xóa vĩnh viễn: chuyển `deleting` (chặn đăng nhập), thu hồi phiên, đưa việc xóa vào hàng đợi.
 * Cần `confirm` khớp email để tránh xóa nhầm.
 */
export async function startDeleteUser(userId: string, confirm: string): Promise<void> {
  const target = await getTarget(userId);
  assertManageable(target);
  if (confirm.trim().toLowerCase() !== target.email.toLowerCase()) {
    throw new HttpError(422, 'VALIDATION', undefined, { confirm: 'Cần nhập đúng email của tài khoản để xác nhận xóa' });
  }
  await getDb().update(users).set({ status: 'deleting', updatedAt: new Date() }).where(eq(users.id, userId));
  await revokeSessions(userId);
  await enqueueDeleteUser(userId);
}
