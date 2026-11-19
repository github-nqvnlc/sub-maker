import { toNextJsHandler } from 'better-auth/next-js';
import { getAuth } from '@/lib/auth/auth';
import { route } from '@/lib/api/errors';

export const dynamic = 'force-dynamic';

// Khởi tạo lười để không đọc biến môi trường lúc build.
// `route()` bắt buộc Origin khớp APP_URL cho mọi yêu cầu ghi, kể cả đăng nhập/đăng ký lần đầu
// (thư viện chỉ kiểm tra Origin khi yêu cầu đã có cookie).
export const GET = route(async (request: Request) => toNextJsHandler(getAuth()).GET(request));
export const POST = route(async (request: Request) => toNextJsHandler(getAuth()).POST(request));
