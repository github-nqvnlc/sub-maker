import { test as base, expect, type APIRequestContext, type Page } from '@playwright/test';

/**
 * Fixture dùng chung cho E2E. Đăng nhập và tạo dữ liệu qua API để các kịch bản UI tập trung
 * vào hành vi cần kiểm tra. Các hàm cụ thể được bổ sung cùng từng user story.
 */
const PORT = Number(process.env.E2E_PORT ?? 3100);
export const ORIGIN = `http://localhost:${PORT}`;

export const E2E_ADMIN = { email: 'admin@e2e.test', password: 'Admin-E2E-7wQ!pL2m' };

export type TestUser = { email: string; password: string; displayName: string };

export function uniqueUser(prefix = 'user'): TestUser {
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  return { email: `${prefix}-${id}@example.test`, password: `Tt-${id}-9xQ!pL2`, displayName: `Người dùng ${id}` };
}

export async function registerViaApi(request: APIRequestContext, user: TestUser) {
  const res = await request.post('/api/auth/sign-up/email', {
    data: { email: user.email, password: user.password, name: user.displayName },
    headers: { Origin: ORIGIN },
  });
  expect(res.ok(), `đăng ký thất bại: ${res.status()} ${await res.text()}`).toBeTruthy();
}

/**
 * Đăng nhập qua giao diện. Mặc định chờ vào được ứng dụng (/projects) để bước kế tiếp không hủy
 * yêu cầu đăng nhập đang chạy; đặt `expectSuccess: false` khi cần kiểm tra đăng nhập thất bại.
 */
export async function loginViaUi(
  page: Page,
  user: Pick<TestUser, 'email' | 'password'>,
  opts: { expectSuccess?: boolean } = {},
) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(user.email);
  await page.getByLabel('Mật khẩu').fill(user.password);
  await page.getByRole('button', { name: 'Đăng nhập' }).click();
  if (opts.expectSuccess ?? true) await expect(page).toHaveURL(/\/(projects|dashboard)/);
}

/** Thông báo lỗi của biểu mẫu (loại trừ thẻ thông báo điều hướng của Next.js cũng có role=alert). */
export const formAlert = (page: Page) => page.locator('p[role="alert"]');

/** PNG 1x1 hợp lệ dùng cho kiểm thử tải ảnh đại diện. */
export const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

export const test = base;
export { expect };
