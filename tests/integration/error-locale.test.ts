import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TestClient, clearRateLimits, createUser, resetDb } from './helpers';

/**
 * Spec 003, US4 (FR-022): cùng một lỗi API trả `message` theo ngôn ngữ của yêu cầu (cookie `locale`); `code` không đổi theo ngôn ngữ
 * và không lộ chi tiết nội bộ.
 */
beforeAll(async () => {
  await resetDb();
});
beforeEach(async () => {
  await clearRateLimits();
});

const as = (locale?: string) => {
  const c = new TestClient();
  if (locale) c.setCookie('locale', locale);
  return c;
};

describe('lỗi API theo ngôn ngữ', () => {
  it('401 chưa đăng nhập: vi và en cùng code UNAUTHENTICATED, khác message', async () => {
    const vi = await (await as('vi').get('/api/me')).json();
    const en = await (await as('en').get('/api/me')).json();
    const none = await (await as().get('/api/me')).json();
    expect(vi.error.code).toBe('UNAUTHENTICATED');
    expect(en.error.code).toBe('UNAUTHENTICATED');
    expect(vi.error.message).toBe('Bạn cần đăng nhập để tiếp tục.');
    expect(en.error.message).toBe('Please sign in to continue.');
    expect(none.error.message).toBe(vi.error.message); // không có cookie → tiếng Việt
  });

  it('404 tài nguyên không tồn tại', async () => {
    const u = await createUser();
    u.client.setCookie('locale', 'en');
    const res = await u.client.get('/api/projects/00000000-0000-4000-8000-000000000000');
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.message).toBe('This content was not found.');
    u.client.setCookie('locale', 'vi');
    expect((await (await u.client.get('/api/projects/00000000-0000-4000-8000-000000000000')).json()).error.message).toBe('Không tìm thấy nội dung này.');
  });

  it('422 kiểm tra dữ liệu (zod): message chung và từng trường được dịch, code VALIDATION không đổi', async () => {
    const u = await createUser();
    u.client.setCookie('locale', 'en');
    const res = await u.client.patch('/api/me', { json: { displayName: '', bio: 'y'.repeat(501) } });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe('VALIDATION');
    expect(body.error.message).toBe('Some data is not valid. Please check the highlighted fields.');
    expect(body.error.fields.displayName).toBe('Name must be 1 to 60 characters');
    expect(body.error.fields.bio).toBe('Bio can be at most 500 characters');
    u.client.setCookie('locale', 'vi');
    const vi = await (await u.client.patch('/api/me', { json: { displayName: '' } })).json();
    expect(vi.error.fields.displayName).toBe('Tên phải có từ 1 đến 60 ký tự');
  });

  it('lỗi nghiệp vụ có câu viết trực tiếp (409 NO_TIMECODES, trường lỗi tệp)', async () => {
    const u = await createUser();
    u.client.setCookie('locale', 'en');
    const proj = await (await u.client.post('/api/projects', { json: { name: 'p', providerType: 'fpt_marketplace' } })).json();
    const form = new FormData();
    form.set('file', new File([new Uint8Array(0)], 'a.txt', { type: 'text/plain' }));
    const res = await u.client.post(`/api/projects/${proj.id}/files`, { form });
    expect(res.status).toBe(422);
    expect((await res.json()).error.fields.file).toBe('The file is empty.');

    const ok = new FormData();
    ok.set('file', new File(['Một câu.'], 'a.txt', { type: 'text/plain' }));
    const file = await (await u.client.post(`/api/projects/${proj.id}/files`, { form: ok })).json();
    const est = await u.client.post(`/api/files/${file.id}/estimate`, { json: { timing: { mode: 'timed' } } });
    expect(est.status).toBe(409);
    const body = await est.json();
    expect(body.error.code).toBe('NO_TIMECODES');
    expect(body.error.message).toContain('timecode-matched mode cannot be used');
  });

  it('đăng ký với mật khẩu yếu: thông báo của Better Auth cũng theo ngôn ngữ', async () => {
    const c = as('en');
    const res = await c.post('/api/auth/sign-up/email', { json: { email: 'weak-pass@example.test', password: '123', name: 'Weak' } });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.message).toBe('Password must be at least 10 characters');
    const vi = await as('vi').post('/api/auth/sign-up/email', { json: { email: 'weak-pass2@example.test', password: '123', name: 'Weak' } });
    expect((await vi.json()).message).toBe('Mật khẩu phải có ít nhất 10 ký tự');
  });

  it('PATCH /api/me chấp nhận locale hợp lệ và các lỗi 500 không lộ chi tiết nội bộ ở cả hai ngôn ngữ', async () => {
    const u = await createUser();
    expect((await u.client.patch('/api/me', { json: { locale: 'en' } })).status).toBe(200);
    // đường dẫn không tồn tại trong router giả → test này chỉ kiểm tra thông điệp 500 chung qua kiểu lỗi không lường trước
    const { toErrorResponse } = await import('@/lib/api/errors');
    const spy = console.error;
    console.error = () => undefined;
    try {
      const en = await toErrorResponse(new Error('secret db detail'), 'en').json();
      const vi = await toErrorResponse(new Error('secret db detail'), 'vi').json();
      expect(en.error).toEqual({ code: 'INTERNAL', message: 'A system error occurred. Please try again later.' });
      expect(vi.error.message).toBe('Đã xảy ra lỗi hệ thống. Vui lòng thử lại sau.');
      expect(JSON.stringify([en, vi])).not.toContain('secret');
    } finally {
      console.error = spy;
    }
  });
});
