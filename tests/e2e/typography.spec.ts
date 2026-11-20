import { expect, test } from './fixtures';

/**
 * Spec 003, US5 (FR-026…FR-028, SC-006): mọi ký tự tiếng Việt lấy từ font chính (Be Vietnam Pro), dấu không bị cắt,
 * font dự phòng hỗ trợ tiếng Việt khi font chưa tải. Dùng trang kiểm thử /dev/typography (bật khi E2E_MODE=1).
 */
test.describe('font chữ tiếng Việt (spec 003, US5)', () => {
  test('100% ký tự tiếng Việt được phủ bởi font chính đã tải', async ({ page }) => {
    await page.goto('/dev/typography');
    await expect(page.getByRole('heading', { name: 'Kiểm thử chữ tiếng Việt' })).toBeVisible();
    await page.evaluate(() => document.fonts.ready);

    const result = await page.evaluate(() => {
      const text = [...document.querySelectorAll('[data-testid="lower"], [data-testid="upper"]')].map((e) => e.textContent ?? '').join(' ');
      const chars = [...new Set([...text.normalize('NFC')].filter((c) => /\p{L}/u.test(c)))];
      const faces = [...document.fonts].filter((f) => /Be[ _]Vietnam[ _]Pro/i.test(f.family));
      const parse = (range: string) =>
        range
          .split(',')
          .map((r) => r.trim().replace(/^U\+/i, ''))
          .map((r) => {
            const [a, b] = r.split('-');
            const lo = parseInt(a!, 16);
            const hi = b ? parseInt(b, 16) : lo;
            return [lo, hi] as const;
          });
      const covered = (cp: number) => faces.some((f) => f.status === 'loaded' && parse(f.unicodeRange).some(([lo, hi]) => cp >= lo && cp <= hi));
      return { total: chars.length, missing: chars.filter((c) => !covered(c.codePointAt(0)!)), faces: faces.map((f) => `${f.weight}:${f.status}`) };
    });
    expect(result.total).toBeGreaterThan(130); // 67 chữ thường + 67 chữ hoa có dấu và đ/Đ
    expect(result.faces.length).toBeGreaterThan(0);
    expect(result.missing, `ký tự không thuộc font chính: ${result.missing.join(' ')}`).toEqual([]);
  });

  test('họ font chính đứng đầu, chuỗi dự phòng đều hỗ trợ tiếng Việt, chiều cao dòng đủ chứa dấu chồng', async ({ page }) => {
    await page.goto('/dev/typography');
    const info = await page.evaluate(() => {
      const body = getComputedStyle(document.body);
      const h = document.querySelector('h2')!;
      const hs = getComputedStyle(h);
      const btn = document.querySelector('button')!;
      const bs = getComputedStyle(btn);
      const lh = (cs: CSSStyleDeclaration) => (cs.lineHeight === 'normal' ? 1.2 : parseFloat(cs.lineHeight) / parseFloat(cs.fontSize));
      return { family: body.fontFamily, bodyLh: lh(body), headingLh: lh(hs), buttonLh: lh(bs) };
    });
    expect(info.family.split(',')[0]).toMatch(/Be[ _]Vietnam[ _]Pro/i);
    expect(info.family).toMatch(/system-ui/);
    expect(info.bodyLh).toBeGreaterThanOrEqual(1.4);
    expect(info.headingLh).toBeGreaterThanOrEqual(1.25);
    expect(info.buttonLh).toBeGreaterThanOrEqual(1.25);
  });

  test('dấu chồng "Ệ Ữ Ẳ" không bị cắt ở tiêu đề, nút và ô nhập', async ({ page }) => {
    await page.goto('/dev/typography');
    await page.evaluate(() => document.fonts.ready);
    const clipped = await page.evaluate(() => {
      const els = [document.querySelector('section h2'), document.querySelector('section button'), document.querySelector('section input')] as HTMLElement[];
      return els.map((el) => {
        const r = el.getBoundingClientRect();
        // vùng chữ thật (không tính khoảng đệm): dựng Range quanh nội dung, hoặc dùng scrollHeight của ô nhập
        if (el instanceof HTMLInputElement) return el.scrollHeight > el.clientHeight + 1;
        const range = document.createRange();
        range.selectNodeContents(el);
        const t = range.getBoundingClientRect();
        return t.top < r.top - 1 || t.bottom > r.bottom + 1 || el.scrollHeight > el.clientHeight + 1;
      });
    });
    expect(clipped).toEqual([false, false, false]);
  });

  test('font chưa tải được: chữ vẫn hiện bằng font dự phòng, không để trống', async ({ page }) => {
    await page.route(/\/_next\/static\/media\/.*\.(woff2?|ttf|otf)/, (route) => route.abort());
    await page.goto('/dev/typography');
    await expect(page.getByRole('heading', { name: 'Kiểm thử chữ tiếng Việt' })).toBeVisible();
    const visible = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="lower"]') as HTMLElement;
      const r = el.getBoundingClientRect();
      return { w: r.width, h: r.height, color: getComputedStyle(el).color, opacity: getComputedStyle(el).opacity };
    });
    expect(visible.w).toBeGreaterThan(100);
    expect(visible.h).toBeGreaterThan(10);
    expect(visible.opacity).toBe('1');
  });
});
