import { eq, sql } from 'drizzle-orm';
import { env } from '../env';
import { getDb } from '../db';
import { accounts, users } from '../db/schema';
import { getAuth } from './auth';

/**
 * Tạo/đồng bộ tài khoản Administrator từ cấu hình triển khai (idempotent).
 * Đăng ký công khai KHÔNG bao giờ tạo được admin (role là trường input:false).
 */
export async function seedAdmin(): Promise<{ created: boolean; passwordUpdated: boolean }> {
  const { ADMIN_EMAIL, ADMIN_PASSWORD } = env();
  const email = ADMIN_EMAIL.toLowerCase();
  const db = getDb();
  const auth = getAuth();
  const ctx = await auth.$context;

  const [existing] = await db.select().from(users).where(sql`lower(${users.email}) = ${email}`).limit(1);

  if (!existing) {
    await auth.api.signUpEmail({ body: { email, password: ADMIN_PASSWORD, name: 'Administrator' } });
    await db.update(users).set({ role: 'admin', status: 'active', emailVerified: true }).where(sql`lower(${users.email}) = ${email}`);
    return { created: true, passwordUpdated: false };
  }

  // Bảo đảm vai trò/trạng thái đúng ngay cả khi ai đó đã đổi trực tiếp trong DB
  if (existing.role !== 'admin' || existing.status !== 'active') {
    await db.update(users).set({ role: 'admin', status: 'active' }).where(eq(users.id, existing.id));
  }

  // Đồng bộ mật khẩu nếu cấu hình đã đổi
  const [account] = await db
    .select()
    .from(accounts)
    .where(sql`${accounts.userId} = ${existing.id} and ${accounts.providerId} = 'credential'`)
    .limit(1);
  const matches = account?.password ? await ctx.password.verify({ hash: account.password, password: ADMIN_PASSWORD }) : false;
  if (!matches) {
    const hash = await ctx.password.hash(ADMIN_PASSWORD);
    if (account) {
      await db.update(accounts).set({ password: hash, updatedAt: new Date() }).where(eq(accounts.id, account.id));
    } else {
      await db.insert(accounts).values({ accountId: existing.id, providerId: 'credential', userId: existing.id, password: hash });
    }
    return { created: false, passwordUpdated: true };
  }
  return { created: false, passwordUpdated: false };
}
