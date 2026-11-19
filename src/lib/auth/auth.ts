import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { eq } from 'drizzle-orm';
import { env } from '../env';
import { getDb } from '../db';
import { accounts, rateLimits, sessions, users, verifications } from '../db/schema';
import { vi } from '../i18n/vi';
import { displayNameSchema, passwordSchema } from '../schemas/common';

/**
 * Cấu hình xác thực (Spike S5 đã kiểm tra API thực tế của Better Auth).
 * - Email + mật khẩu, băm mật khẩu có muối (scrypt mặc định của thư viện).
 * - Giới hạn tốc độ đăng nhập/đăng ký lưu bền trong DB.
 * - IP thật lấy từ `CF-Connecting-IP` (chỉ đáng tin vì web chỉ nhận lưu lượng qua Cloudflare Tunnel).
 * - Tài khoản `banned`/`deleting` không tạo được phiên.
 * Hợp đồng nội bộ với phần còn lại của ứng dụng nằm ở guards.ts; thay thư viện không ảnh hưởng nơi khác.
 */

function build() {
  const e = env();
  const isProd = e.NODE_ENV === 'production';

  return betterAuth({
    appName: 'Sub Maker',
    baseURL: e.APP_URL,
    secret: e.AUTH_SECRET,
    trustedOrigins: [new URL(e.APP_URL).origin],
    database: drizzleAdapter(getDb(), {
      provider: 'pg',
      schema: {
        user: users,
        session: sessions,
        account: accounts,
        verification: verifications,
        rateLimit: rateLimits,
      },
    }),
    advanced: {
      database: { generateId: 'uuid' },
      ipAddress: { ipAddressHeaders: ['cf-connecting-ip', 'x-forwarded-for'] },
      useSecureCookies: isProd,
      defaultCookieAttributes: { sameSite: 'lax', httpOnly: true, secure: isProd },
    },
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 10,
      maxPasswordLength: 128,
      autoSignIn: true,
      // v1: không xác minh email, không quên mật khẩu tự phục vụ (research R4)
      requireEmailVerification: false,
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
    },
    user: {
      additionalFields: {
        bio: { type: 'string', required: false, input: true },
        avatarKey: { type: 'string', required: false, input: false },
        // Các trường do máy chủ quản lý: không nhận từ client (chặn tự nâng quyền)
        role: { type: 'string', required: false, defaultValue: 'user', input: false },
        status: { type: 'string', required: false, defaultValue: 'active', input: false },
        canUseCustomAi: { type: 'boolean', required: false, defaultValue: false, input: false },
        storageUsedBytes: { type: 'number', required: false, defaultValue: 0, input: false },
        lastActiveAt: { type: 'date', required: false, input: false },
      },
    },
    rateLimit: {
      enabled: true,
      storage: 'database',
      window: 60,
      max: 100,
      customRules: {
        '/sign-in/email': { window: 60, max: e.RATE_LIMIT_SIGNIN_PER_MIN },
        '/sign-up/email': { window: 3600, max: e.RATE_LIMIT_SIGNUP_PER_HOUR },
        '/change-password': { window: 60, max: e.RATE_LIMIT_SIGNIN_PER_MIN },
      },
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        const body = (ctx.body ?? {}) as Record<string, unknown>;
        if (ctx.path === '/sign-up/email') {
          const name = displayNameSchema.safeParse(body.name);
          if (!name.success) {
            throw new APIError('UNPROCESSABLE_ENTITY', { message: name.error.issues[0]?.message ?? vi.validation.nameLength });
          }
        }
        if (ctx.path === '/sign-up/email' || ctx.path === '/change-password' || ctx.path === '/reset-password') {
          const pw = passwordSchema.safeParse(body.password ?? body.newPassword);
          if (!pw.success) {
            throw new APIError('UNPROCESSABLE_ENTITY', { message: pw.error.issues[0]?.message ?? vi.validation.passwordMin });
          }
        }
      }),
    },
    databaseHooks: {
      session: {
        create: {
          before: async (session) => {
            const [u] = await getDb().select({ status: users.status }).from(users).where(eq(users.id, session.userId)).limit(1);
            if (!u || u.status !== 'active') {
              throw new APIError('FORBIDDEN', { message: vi.errors.ACCOUNT_DISABLED });
            }
          },
        },
      },
    },
  });
}

type Auth = ReturnType<typeof build>;

const g = globalThis as unknown as { __submakerAuth?: { key: string; auth: Auth } };

/** Khởi tạo lười để `next build` không cần biến môi trường. */
export function getAuth(): Auth {
  const key = `${process.env.DATABASE_URL}|${process.env.AUTH_SECRET}|${process.env.APP_URL}`;
  if (!g.__submakerAuth || g.__submakerAuth.key !== key) {
    g.__submakerAuth = { key, auth: build() };
  }
  return g.__submakerAuth.auth;
}
