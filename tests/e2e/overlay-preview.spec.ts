import type { Page } from '@playwright/test';
import { startMockProvider, type MockProvider } from '../../mock-provider/server';
import { expect, test } from './fixtures';
import { expectNoHorizontalScroll, openOverlay, overlayProject, previewBox, previewHash, seek } from './overlay-helpers';

/** Spec 005, US2–US4, US7: khung xem trước dùng cùng bộ vẽ với video; mọi thay đổi hiện ngay (SC-004) và được tự lưu (FR-016). */
let mock: MockProvider;

test.beforeAll(async () => {
  mock = await startMockProvider();
});
test.afterAll(async () => {
  await mock.close();
});

const select = async (page: Page, label: string, option: string | RegExp) => {
  await page.getByRole('combobox', { name: label, exact: true }).click();
  await page.getByRole('option', { name: option }).click();
};
const audio = (page: Page) => page.getByTestId('overlay-audio').evaluate((el) => ({ paused: (el as HTMLAudioElement).paused, time: (el as HTMLAudioElement).currentTime }));

/** Số điểm ảnh gần vàng (#FFE600) trên khung xem trước. */
const yellow = (page: Page) =>
  page.getByTestId('overlay-canvas').evaluate((el) => {
    const c = el as HTMLCanvasElement;
    const { data } = c.getContext('2d')!.getImageData(0, 0, c.width, c.height);
    let n = 0;
    for (let o = 0; o < data.length; o += 4) if (data[o]! > 235 && data[o + 1]! > 210 && data[o + 1]! < 245 && data[o + 2]! < 60) n++;
    return n;
  });

/**
 * Đo từ lần bấm kế tiếp tới khung hình đầu tiên mà khung xem trước đổi nội dung (ms). Trả hàm đọc kết quả.
 * Lấy mẫu một dải giữa vùng chữ để phép đo không làm chậm trang.
 */
async function armLatency(page: Page, event: 'click' | 'seeking'): Promise<() => Promise<number>> {
  await page.evaluate((ev) => {
    const w = window as unknown as { __latency?: number };
    w.__latency = undefined;
    const c = document.querySelector('[data-testid=overlay-canvas]') as HTMLCanvasElement;
    const a = document.querySelector('[data-testid=overlay-audio]') as HTMLAudioElement;
    const g = c.getContext('2d')!;
    const sample = () => {
      const d = g.getImageData(0, Math.floor(c.height * 0.76), c.width, 160).data;
      let h = 0;
      for (let i = 0; i < d.length; i += 28) h = (Math.imul(h, 31) + d[i]! + d[i + 1]! * 3 + d[i + 2]! * 7) | 0;
      return h;
    };
    const start = () => {
      const t0 = performance.now();
      const before = sample();
      const loop = () => {
        if (sample() !== before) w.__latency = performance.now() - t0;
        else requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    };
    (ev === 'click' ? document : a).addEventListener(ev, start, { capture: true, once: true });
  }, event);
  return async () => {
    await expect.poll(() => page.evaluate(() => (window as unknown as { __latency?: number }).__latency ?? -1), { intervals: [20] }).toBeGreaterThan(0);
    return page.evaluate(() => (window as unknown as { __latency: number }).__latency);
  };
}

test.describe('khung xem trước (US2)', () => {
  test('đang phát: đổi kiểu hiện trong 0,2 giây, tiếng không ngắt; tua thì chữ đúng trong 0,5 giây', async ({ page }) => {
    const p = await overlayProject(page, mock, 'preview');
    await openOverlay(page, p.id);

    // Không tự phát: chờ người dùng bấm
    expect((await audio(page)).paused).toBe(true);
    await seek(page, 700);
    await page.getByTestId('overlay-play').click();
    await expect.poll(async () => (await audio(page)).paused).toBe(false);
    await expect(page.getByTestId('overlay-play')).toHaveAttribute('aria-label', 'Tạm dừng');

    const styled = await armLatency(page, 'click');
    const before = (await audio(page)).time;
    await page.getByRole('button', { name: 'Vàng', exact: true }).first().click();
    expect(await styled()).toBeLessThanOrEqual(200);
    const after = await audio(page);
    expect(after.paused).toBe(false);
    expect(after.time).toBeGreaterThan(before);
    expect(await yellow(page)).toBeGreaterThan(2000);
    await page.getByTestId('overlay-play').click();
    await expect.poll(async () => (await audio(page)).paused).toBe(true);

    // Tua tới giữa câu thứ hai: khung đúng nội dung trong 0,5 giây
    await seek(page, 1500);
    const sought = await armLatency(page, 'seeking');
    await seek(page, 6500);
    expect(await sought()).toBeLessThanOrEqual(500);
    const there = await previewHash(page);
    await seek(page, 1500);
    expect(await previewHash(page)).not.toBe(there);
    await seek(page, 6500);
    expect(await previewHash(page)).toBe(there);
    // Trước câu đầu: chỉ có nền
    await seek(page, 100);
    expect(await previewBox(page)).toBeNull();
  });

  test('đổi từng thuộc tính khi dừng: khung xem trước và tỉ lệ đổi theo @mobile', async ({ page }) => {
    const p = await overlayProject(page, mock, 'style');
    await openOverlay(page, p.id);
    await seek(page, 2000);
    const canvas = page.getByTestId('overlay-canvas');
    let last = await previewHash(page);
    const changed = async (what: string) => {
      await expect.poll(() => previewHash(page), { message: what, intervals: [50, 100] }).not.toBe(last);
      last = await previewHash(page);
    };

    const base = (await previewBox(page))!;
    await page.getByRole('slider', { name: 'Cỡ chữ' }).focus();
    for (let k = 0; k < 12; k++) await page.keyboard.press('ArrowLeft');
    await changed('cỡ chữ');
    expect((await previewBox(page))!.pixels).toBeLessThan(base.pixels);

    await select(page, 'Phông chữ', 'Montserrat');
    await expect(canvas).toHaveAttribute('data-fonts', 'ready');
    await changed('phông chữ');
    await select(page, 'Độ đậm', 'Rất đậm');
    await changed('độ đậm');
    // Arimo không có "Rất đậm": tự về "Đậm" và lựa chọn bị khóa
    await select(page, 'Phông chữ', 'Arimo (Arial)');
    await changed('arimo');
    await expect(page.getByRole('combobox', { name: 'Độ đậm' })).toContainText('Đậm');
    await page.getByRole('combobox', { name: 'Độ đậm' }).click();
    await expect(page.getByRole('option', { name: /Rất đậm \(phông chữ này không có\)/ })).toBeDisabled();
    await page.keyboard.press('Escape');

    await page.getByRole('switch', { name: 'Hộp nền sau chữ' }).click();
    await changed('hộp nền');
    await page.getByRole('switch', { name: 'Bóng đổ' }).click();
    await changed('bóng đổ');
    await page.getByRole('switch', { name: 'Viền chữ' }).click();
    await changed('viền');
    const low = (await previewBox(page))!;
    await select(page, 'Vị trí nhanh', 'Trên cùng');
    await changed('vị trí');
    expect((await previewBox(page))!.y).toBeLessThan(low.y);
    await select(page, 'Canh lề', 'Trái');
    await changed('canh lề');

    const color = page.getByLabel('Màu chữ', { exact: true });
    await color.fill('#12345');
    await expect(page.getByText('Màu phải có dạng #RRGGBB')).toBeVisible();
    await color.fill('#FF4500');
    await changed('màu chữ');

    await select(page, 'Tỉ lệ khung hình', /^16:9/);
    await expect(canvas).toHaveAttribute('width', '1920');
    await expect(canvas).toHaveAttribute('height', '1080');
    const ratio = await canvas.evaluate((el) => el.clientWidth / el.clientHeight);
    expect(ratio).toBeCloseTo(16 / 9, 1);
    await expectNoHorizontalScroll(page);
  });

  test('tự lưu: rời trang hoặc chuyển tab ngay vẫn còn cấu hình; "Về mặc định" đưa lại như đầu', async ({ page }) => {
    const p = await overlayProject(page, mock, 'save');
    await openOverlay(page, p.id);
    // chuyển tab ngay sau khi đổi (chưa hết thời gian chờ lưu)
    await select(page, 'Tỉ lệ khung hình', /^1:1/);
    await page.getByRole('tab', { name: /Voice \(/ }).click();
    await page.getByRole('tab', { name: /Video Overlay/ }).click();
    await expect(page.getByRole('combobox', { name: 'Tỉ lệ khung hình' })).toContainText('1:1');
    const saved = page.waitForResponse((r) => r.url().endsWith('/overlay') && r.request().method() === 'PUT');
    await select(page, 'Phông chữ', 'Roboto');
    expect((await saved).status()).toBeLessThan(300);
    await openOverlay(page, p.id);
    await expect(page.getByRole('combobox', { name: 'Tỉ lệ khung hình' })).toContainText('1:1');
    await expect(page.getByRole('combobox', { name: 'Phông chữ' })).toContainText('Roboto');

    await page.getByRole('button', { name: 'Về mặc định' }).click();
    await expect(page.getByRole('combobox', { name: 'Tỉ lệ khung hình' })).toContainText('9:16');
    await expect(page.getByRole('combobox', { name: 'Phông chữ' })).toContainText('Be Vietnam Pro');
  });

  test('lưu lỗi: báo rõ, thay đổi trên màn hình vẫn còn, lần chỉnh sau lưu lại được', async ({ page }) => {
    const p = await overlayProject(page, mock, 'saveerr');
    await openOverlay(page, p.id);
    await page.route(/\/overlay$/, (route) => (route.request().method() === 'PUT' ? route.fulfill({ status: 503, json: { error: { code: 'INTERNAL', message: 'lỗi' } } }) : route.continue()));
    await select(page, 'Tỉ lệ khung hình', /^1:1/);
    await expect(page.getByText('Chưa lưu được cấu hình; thay đổi trên màn hình vẫn còn')).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Tỉ lệ khung hình' })).toContainText('1:1');
    await page.unroute(/\/overlay$/);
    await select(page, 'Phông chữ', 'Inter');
    await expect(page.getByText('Chưa lưu được cấu hình; thay đổi trên màn hình vẫn còn')).toBeHidden();
    await openOverlay(page, p.id);
    await expect(page.getByRole('combobox', { name: 'Tỉ lệ khung hình' })).toContainText('1:1');
  });

  test('màu trùng phông được cảnh báo; phông đen tự tắt viền đen và báo', async ({ page }) => {
    const p = await overlayProject(page, mock, 'warn');
    await openOverlay(page, p.id);
    await page.getByLabel('Màu chữ', { exact: true }).fill('#00FF66');
    await expect(page.getByText('Màu chữ gần trùng màu phông nên sẽ mất khi xóa phông')).toBeVisible();
    await page.getByRole('button', { name: 'Về mặc định' }).click();
    await expect(page.getByText('Màu chữ gần trùng màu phông')).toBeHidden();

    await expect(page.getByRole('switch', { name: 'Viền chữ' })).toBeChecked();
    await select(page, 'Nền video', /^Phông đen/);
    await expect(page.getByText('Đã tắt viền đen vì sẽ biến mất trên phông đen')).toBeVisible();
    await expect(page.getByRole('switch', { name: 'Viền chữ' })).not.toBeChecked();
  });
});

test.describe('hiệu ứng (US3, US4)', () => {
  test('đổi hiệu ứng câu thấy ngay; chọn mờ dần thì cách biến mất đổi theo', async ({ page }) => {
    const p = await overlayProject(page, mock, 'fx');
    await openOverlay(page, p.id);
    // khung ngay đầu câu: với "Nảy" chữ nhỏ hơn lúc đứng yên
    await seek(page, 2500);
    const still = (await previewBox(page))!;
    await select(page, 'Hiệu ứng xuất hiện', 'Nảy');
    await expect(page.getByRole('slider', { name: 'Thời lượng hiệu ứng' })).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Độ nảy và cường độ' })).toBeVisible();
    let smallest = Number.POSITIVE_INFINITY;
    for (let ms = 300; ms <= 1000; ms += 25) {
      await seek(page, ms);
      const b = await previewBox(page);
      if (b) smallest = Math.min(smallest, b.w);
    }
    expect(smallest).toBeLessThan(still.w * 0.95);

    await select(page, 'Hiệu ứng xuất hiện', 'Mờ dần');
    await expect(page.getByRole('combobox', { name: 'Cách biến mất' })).toContainText('Mờ dần');
    await expect(page.getByText(/Có vùng bán trong suốt/)).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Độ nảy và cường độ' })).toBeHidden();
    // người dùng đổi lại được
    await select(page, 'Cách biến mất', 'Tắt ngay');
    await expect(page.getByRole('combobox', { name: 'Cách biến mất' })).toContainText('Tắt ngay');
    await select(page, 'Hiệu ứng xuất hiện', 'Rung nhẹ');
    await expect(page.getByRole('combobox', { name: 'Phạm vi rung' })).toContainText('Chỉ câu cảm thán');
  });

  test('karaoke và theo từng từ: có ghi chú ước lượng, màu nổi bật, đổi chế độ tự chỉnh lựa chọn không hợp', async ({ page }) => {
    const p = await overlayProject(page, mock, 'words');
    await openOverlay(page, p.id);
    await seek(page, 2000);
    expect(await yellow(page)).toBe(0);
    await select(page, 'Hiệu ứng xuất hiện', 'Bung ra');
    await select(page, 'Chế độ đồng bộ', 'Karaoke');
    await expect(page.getByText('Nhịp từng từ là ước lượng')).toBeVisible();
    await expect.poll(() => yellow(page)).toBeGreaterThan(300);
    await page.getByRole('button', { name: 'Đỏ cam', exact: true }).click();
    await expect.poll(() => yellow(page)).toBe(0);
    await select(page, 'Hiệu ứng từ', 'Quét màu');
    await expect(page.getByRole('combobox', { name: 'Hiệu ứng xuất hiện' })).toContainText('Bung ra');

    await select(page, 'Chế độ đồng bộ', 'Theo từng từ');
    await expect(page.getByText('Một số lựa chọn không hợp với chế độ mới đã được đưa về mặc định')).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Hiệu ứng xuất hiện' })).toBeHidden();
    await expect(page.getByRole('combobox', { name: 'Hiệu ứng từ' })).toContainText('Hiện từng từ');
    // chữ tăng dần theo thời gian
    await seek(page, 800);
    const early = (await previewBox(page))!.pixels;
    await seek(page, 3800);
    expect((await previewBox(page))!.pixels).toBeGreaterThan(early * 1.5);
    await select(page, 'Chế độ đồng bộ', 'Theo câu');
    await expect(page.getByText('Nhịp từng từ là ước lượng')).toBeHidden();
  });
});

test.describe('nền trong suốt (US7)', () => {
  test('chỉ có định dạng hợp lệ, ghi phần mềm phù hợp, ô bàn cờ không nằm trong khung vẽ', async ({ page }) => {
    const p = await overlayProject(page, mock, 'alpha');
    await openOverlay(page, p.id);
    await page.getByRole('combobox', { name: 'Định dạng' }).click();
    await expect(page.getByRole('option')).toHaveCount(1);
    await page.keyboard.press('Escape');

    await select(page, 'Nền video', /^Trong suốt/);
    await expect(page.getByText('Ô bàn cờ chỉ để phân biệt vùng trong suốt, không nằm trong video.')).toBeVisible();
    await expect(page.getByText(/khoảng 2–3,5 phút/)).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Định dạng' })).toContainText('.mov (Premiere, DaVinci Resolve, After Effects)');
    await seek(page, 2000);
    const corner = await page.getByTestId('overlay-canvas').evaluate((el) => [...(el as HTMLCanvasElement).getContext('2d')!.getImageData(3, 3, 1, 1).data]);
    expect(corner[3]).toBe(0);
    await select(page, 'Định dạng', /^\.webm/);
    await expect(page.getByText(/khoảng 2–3,5 phút/)).toBeHidden();
    await select(page, 'Nền video', /^Phông xanh lá/);
    await expect(page.getByRole('combobox', { name: 'Định dạng' })).toContainText('.mp4');
  });
});
