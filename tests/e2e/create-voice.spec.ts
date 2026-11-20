import { startMockProvider, type MockProvider } from '../../mock-provider/server';
import { E2E_ADMIN, ORIGIN, expect, formAlert, loginViaUi, registerViaApi, test, uniqueUser } from './fixtures';
import type { APIRequestContext } from '@playwright/test';

/**
 * US1 (quickstart #2–#3, #13) qua ĐƯỜNG THẬT: giao diện → API → hàng đợi pg-boss → worker → nhà cung cấp giả.
 * Máy chủ nhà cung cấp giả chạy trong tiến trình test; web/worker E2E (E2E_MODE) cho phép http/loopback.
 */
let mock: MockProvider;

async function configureGlobalProvider(request: APIRequestContext, mockUrl: string) {
  const signIn = await request.post('/api/auth/sign-in/email', { data: E2E_ADMIN, headers: { Origin: ORIGIN } });
  expect(signIn.ok(), 'đăng nhập admin').toBeTruthy();
  const put = await request.put('/api/admin/ai-configs', {
    data: { type: 'fpt_marketplace', baseUrl: `${mockUrl}/s/ok/v1`, apiKey: 'sk-e2e-create-voice-key-0001', defaultModel: 'FPT.AI-VITs', defaultVoice: 'banmai' },
    headers: { Origin: ORIGIN },
  });
  expect(put.ok(), `cấu hình AI chung: ${put.status()}`).toBeTruthy();
}

test.beforeAll(async () => {
  mock = await startMockProvider();
});
test.afterAll(async () => {
  await mock.close();
});

const SCRIPT = ['Xin chào các bạn.', 'Hôm nay chúng ta học bài mới.', 'Cảm ơn đã theo dõi.'].join('\n');

test.describe('tạo voice từ kịch bản (US1)', () => {
  test('tạo Project → tải kịch bản → xem trước các đoạn → tạo voice → theo dõi log tới khi hoàn tất @mobile', async ({ page, playwright }) => {
    const adminApi = await playwright.request.newContext({ baseURL: ORIGIN });
    await configureGlobalProvider(adminApi, mock.url);
    await adminApi.dispose();

    const user = uniqueUser('voice');
    await page.goto('/register');
    await page.getByLabel('Tên hiển thị').fill(user.displayName);
    await page.getByLabel('Email').fill(user.email);
    await page.getByLabel('Mật khẩu').fill(user.password);
    await page.getByRole('button', { name: 'Đăng ký' }).click();
    await expect(page).toHaveURL(/\/projects/);

    // 1) Tạo Project
    await page.getByRole('button', { name: 'Tạo Project' }).first().click();
    await page.getByLabel('Tên Project').fill('Kênh lịch sử Việt Nam');
    await page.getByLabel('Mô tả').fill('Các video về lịch sử.');
    await page.getByRole('dialog').getByRole('button', { name: 'Tạo Project' }).click();
    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}$/);
    await expect(page.getByRole('heading', { name: 'Kênh lịch sử Việt Nam' })).toBeVisible();

    // 2) Tải kịch bản: tự mở xem trước các đoạn sẽ đọc
    await page.getByLabel('Tải kịch bản lên').setInputFiles({ name: 'kich-ban.txt', mimeType: 'text/plain', buffer: Buffer.from(SCRIPT, 'utf8') });
    const preview = page.getByRole('dialog');
    await expect(preview.getByText('Xin chào các bạn.')).toBeVisible();
    await expect(preview.getByText('Cảm ơn đã theo dõi.')).toBeVisible();
    await expect(preview.getByText(/3 đoạn/)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toBeHidden();

    // 3) Tạo voice
    await page.getByRole('button', { name: 'Tạo voice' }).first().click();
    await page.getByRole('dialog').getByRole('button', { name: 'Bắt đầu tạo voice' }).click();
    await expect(page).toHaveURL(/\/jobs\/[0-9a-f-]{36}$/);

    // 4) Log chi tiết hiện trên màn hình theo thời gian thực cho tới khi hoàn tất
    const log = page.getByRole('log');
    await expect(log).toContainText('Bắt đầu tạo voice', { timeout: 20_000 });
    await expect(log).toContainText('Dùng cấu hình chung của hệ thống');
    await expect(log).toContainText('Hoàn tất tạo voice', { timeout: 60_000 });
    await expect(log).toContainText('Đang ghép');
    await expect(page.getByText('Hoàn tất').first()).toBeVisible();
    await expect(page.getByText(/3\/3/)).toBeVisible();
    await expect(page.getByRole('link', { name: 'Nghe voice' })).toBeVisible();

    // Log không bao giờ lộ khóa API
    expect(await page.content()).not.toContain('sk-e2e-create-voice-key');

    // 5) Quay lại Project: voice nằm trong danh sách, tiến trình hoàn tất
    await page.getByRole('link', { name: 'Về Project' }).click();
    await page.getByRole('tab', { name: /Tiến trình/ }).click();
    await expect(page.getByText('Hoàn tất').first()).toBeVisible();
    await page.getByRole('tab', { name: /Voice/ }).click();
    await expect(page.getByRole('link', { name: 'Nghe' })).toBeVisible();
  });

  test('tệp không hợp lệ bị từ chối kèm lý do rõ ràng, không tạo gì', async ({ page, request }) => {
    const user = uniqueUser('badfile');
    await registerViaApi(request, user);
    await loginViaUi(page, user);

    await page.getByRole('button', { name: 'Tạo Project' }).first().click();
    await page.getByLabel('Tên Project').fill('Thử tệp lỗi');
    await page.getByRole('dialog').getByRole('button', { name: 'Tạo Project' }).click();
    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}$/);

    // Sai định dạng (chặn ngay ở phía client)
    await page.getByLabel('Tải kịch bản lên').setInputFiles({ name: 'a.pdf', mimeType: 'application/pdf', buffer: Buffer.from('x') });
    await expect(formAlert(page)).toContainText('.txt, .md, .srt');

    // Quá 2 MB (máy chủ từ chối)
    await page.getByLabel('Tải kịch bản lên').setInputFiles({ name: 'lon.txt', mimeType: 'text/plain', buffer: Buffer.alloc(2 * 1024 * 1024 + 100, 97) });
    await expect(formAlert(page)).toContainText('2 MB');

    // Không phải UTF-8
    await page.getByLabel('Tải kịch bản lên').setInputFiles({ name: 'sai.txt', mimeType: 'text/plain', buffer: Buffer.from([0x41, 0xc3, 0x28]) });
    await expect(formAlert(page)).toContainText('UTF-8');

    await page.getByRole('tab', { name: /Kịch bản \(0\)/ }).click();
    await expect(page.getByText('Chưa có kịch bản nào')).toBeVisible();
  });

  test('chưa có cấu hình AI khả dụng: không cho bắt đầu và nêu cách xử lý', async ({ page, request, playwright }) => {
    // xóa cấu hình chung để mô phỏng chưa cấu hình
    const adminApi = await playwright.request.newContext({ baseURL: ORIGIN });
    await adminApi.post('/api/auth/sign-in/email', { data: E2E_ADMIN, headers: { Origin: ORIGIN } });
    await adminApi.delete('/api/admin/ai-configs/fpt_marketplace', { headers: { Origin: ORIGIN } });
    await adminApi.dispose();

    const user = uniqueUser('noprov');
    await registerViaApi(request, user);
    await loginViaUi(page, user);
    await page.getByRole('button', { name: 'Tạo Project' }).first().click();
    await page.getByLabel('Tên Project').fill('Chưa cấu hình');
    await page.getByRole('dialog').getByRole('button', { name: 'Tạo Project' }).click();
    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}$/);
    await page.getByLabel('Tải kịch bản lên').setInputFiles({ name: 'k.txt', mimeType: 'text/plain', buffer: Buffer.from('Một dòng.\nHai dòng.') });
    // Chờ hộp thoại xem trước mở rồi mới đóng (bấm Escape quá sớm thì hộp thoại mở sau và che trang)
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toBeHidden();
    await page.getByRole('button', { name: 'Tạo voice' }).first().click();
    const dlg = page.getByRole('dialog');
    await expect(dlg.getByText(/Chưa có cấu hình AI khả dụng/)).toBeVisible();
    await expect(dlg.getByRole('button', { name: 'Bắt đầu tạo voice' })).toBeDisabled();
  });
});

test.describe('chọn giọng đọc khi tạo voice', () => {
  test('hộp thoại "Tạo voice" cho chọn model và giọng; giọng đã chọn được dùng cho tiến trình', async ({ page, request, playwright }) => {
    const adminApi = await playwright.request.newContext({ baseURL: ORIGIN });
    await configureGlobalProvider(adminApi, mock.url);
    await adminApi.dispose();
    mock.reset(); // chỉ xét các yêu cầu của kịch bản này

    const user = uniqueUser('pickvoice');
    await registerViaApi(request, user);
    await loginViaUi(page, user);
    const headers = { Origin: ORIGIN };
    const project = await (await page.request.post('/api/projects', { data: { name: 'Chọn giọng', providerType: 'fpt_marketplace' }, headers })).json();
    await page.request.post(`/api/projects/${project.id}/files`, {
      multipart: { file: { name: 'k.txt', mimeType: 'text/plain', buffer: Buffer.from('Xin chào các bạn.\nHẹn gặp lại.', 'utf8') } },
      headers,
    });

    await page.goto(`/projects/${project.id}`);
    await page.getByRole('button', { name: 'Tạo voice' }).first().click();
    const dialog = page.getByRole('dialog');

    // Danh sách giọng nêu rõ giới tính và vùng miền; đổi model thì danh sách giọng đổi theo (giọng không dùng chéo model)
    await dialog.getByRole('combobox', { name: 'Giọng đọc' }).click();
    await expect(page.getByRole('option', { name: 'Lê Minh (nam, miền Bắc)' })).toBeVisible();
    await page.getByRole('option', { name: 'Gia Huy (nam, miền Trung)' }).click();

    await dialog.getByRole('button', { name: 'Bắt đầu tạo voice' }).click();
    await expect(page).toHaveURL(/\/jobs\/[0-9a-f-]{36}$/);
    const jobId = page.url().split('/').pop()!;

    const detail = await (await page.request.get(`/api/jobs/${jobId}`)).json();
    expect(detail.settings.voice).toBe('giahuy');
    // voice được tạo ra ghi đúng giọng đã chọn trong nhật ký/đầu ra của nhà cung cấp giả
    await expect.poll(() => mock.requests.filter((r) => r.method === 'POST').length, { timeout: 30_000 }).toBeGreaterThan(0);
    const sent = mock.requests.filter((r) => r.method === 'POST').map((r) => JSON.parse(r.body) as { voice?: string });
    expect(sent.every((b) => b.voice === 'giahuy')).toBe(true);
  });
});
