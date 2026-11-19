import type { Page } from '@playwright/test';
import { startMockProvider, type MockProvider } from '../../mock-provider/server';
import { E2E_ADMIN, ORIGIN, expect, loginViaUi, registerViaApi, test, uniqueUser } from './fixtures';
import { findActiveIndex } from '../../src/lib/player/active-segment';

/**
 * US3 (quickstart #5): nghe voice, văn bản được làm nổi bật ĐÚNG đoạn đang đọc, tua, bấm câu để phát, tự cuộn.
 * Sinh voice thật qua đường web → worker → máy chủ nhà cung cấp giả; mỗi đoạn dài ~1,5–2 giây để quan sát được.
 */
let mock: MockProvider;

test.beforeAll(async () => {
  mock = await startMockProvider();
});
test.afterAll(async () => {
  await mock.close();
});

const LINES = [
  'Xin chào các bạn, chào mừng đến với kênh.',
  'Hôm nay chúng ta cùng tìm hiểu lịch sử.',
  'Việt Nam có hàng nghìn năm dựng nước.',
  'Mỗi vùng miền đều có nét văn hóa riêng.',
  'Cảm ơn các bạn đã theo dõi, hẹn gặp lại.',
];

type Timeline = { idx: number; text: string; startMs: number; endMs: number }[];

async function setupProvider(page: Page) {
  const signIn = await page.request.post('/api/auth/sign-in/email', { data: E2E_ADMIN, headers: { Origin: ORIGIN } });
  expect(signIn.ok()).toBeTruthy();
  const put = await page.request.put('/api/admin/ai-configs', {
    data: { type: 'fpt_marketplace', baseUrl: `${mock.url}/s/ok/v1`, apiKey: 'sk-e2e-player-key-0002', defaultModel: 'FPT.AI-VITs', defaultVoice: 'banmai' },
    headers: { Origin: ORIGIN },
  });
  expect(put.ok()).toBeTruthy();
  await page.request.post('/api/auth/sign-out', { data: {}, headers: { Origin: ORIGIN } });
}

/** Tạo Project + tải kịch bản + tạo voice qua API (đăng nhập bằng User đã tạo) và chờ hoàn tất. */
async function makeVoice(page: Page, lines: string[]): Promise<{ projectId: string; voiceId: string; timeline: Timeline }> {
  const post = (url: string, data: unknown) => page.request.post(url, { data, headers: { Origin: ORIGIN } });
  const project = await (await post('/api/projects', { name: 'Voice đồng bộ', providerType: 'fpt_marketplace' })).json();
  const upload = await page.request.post(`/api/projects/${project.id}/files`, {
    multipart: { file: { name: 'kich-ban.txt', mimeType: 'text/plain', buffer: Buffer.from(lines.join('\n'), 'utf8') } },
    headers: { Origin: ORIGIN },
  });
  expect(upload.status()).toBe(201);
  const file = await upload.json();
  const job = await (await post(`/api/projects/${project.id}/jobs`, { fileId: file.id })).json();

  let detail: { status: string; voiceId: string | null } = { status: 'queued', voiceId: null };
  await expect
    .poll(
      async () => {
        detail = await (await page.request.get(`/api/jobs/${job.id}`)).json();
        return detail.status;
      },
      { timeout: 90_000, intervals: [500] },
    )
    .toMatch(/completed|failed/);
  expect(detail.status).toBe('completed');
  const voice = await (await page.request.get(`/api/voices/${detail.voiceId}`)).json();
  return { projectId: project.id, voiceId: voice.id, timeline: voice.segments };
}

/** Đọc cùng lúc currentTime và đoạn đang được làm nổi bật (tránh lệch thời gian giữa hai lần đọc). */
const snapshot = (page: Page) =>
  page.evaluate(() => {
    const audio = document.querySelector('audio')!;
    const el = document.querySelector('[data-testid="synced-text"] [data-active="true"]');
    return { tMs: audio.currentTime * 1000, active: el ? Number(el.getAttribute('data-idx')) : -1, paused: audio.paused };
  });

test.describe('nghe voice và highlight đồng bộ (US3)', () => {
  test('highlight đúng đoạn đang đọc, tua, bấm câu để phát, tạm dừng giữ nguyên @mobile', async ({ page, request }) => {
    await setupProvider(page);
    const user = uniqueUser('player');
    await registerViaApi(request, user);
    await loginViaUi(page, user);
    const { projectId, voiceId, timeline } = await makeVoice(page, LINES);
    expect(timeline).toHaveLength(5);

    await page.goto(`/projects/${projectId}/voices/${voiceId}`);
    await expect(page.getByTestId('synced-text')).toBeVisible();
    await expect(page.getByText(LINES[0]!)).toBeVisible();
    // trình duyệt đọc được thời lượng audio
    await expect(page.getByTestId('time-display')).toContainText(/0:00 \/ 0:\d\d/);

    // 1) Phát: mẫu nhiều lần, highlight phải khớp đoạn theo currentTime (cho phép sai lệch ≤ 0,3 giây quanh ranh giới)
    await page.getByTestId('play-toggle').click();
    await expect.poll(async () => (await snapshot(page)).paused, { timeout: 10_000 }).toBe(false);
    const seen = new Set<number>();
    let checked = 0;
    for (let i = 0; i < 24; i++) {
      await page.waitForTimeout(350);
      const s = await snapshot(page);
      if (s.paused) break;
      const expected = findActiveIndex(timeline, s.tMs);
      const near = timeline.some((seg) => Math.abs(s.tMs - seg.startMs) < 300);
      if (!near) expect(s.active, `t=${Math.round(s.tMs)}ms`).toBe(expected);
      else expect([expected, expected - 1, expected + 1]).toContain(s.active);
      seen.add(s.active);
      checked++;
    }
    expect(checked).toBeGreaterThan(8);
    expect(seen.size).toBeGreaterThanOrEqual(3); // highlight thực sự chuyển qua nhiều đoạn

    // 2) Tạm dừng: highlight giữ nguyên
    await page.getByTestId('play-toggle').click();
    await expect.poll(async () => (await snapshot(page)).paused).toBe(true);
    const frozen = await snapshot(page);
    await page.waitForTimeout(600);
    expect((await snapshot(page)).active).toBe(frozen.active);

    // 3) Tua tới giữa đoạn 4 (như kéo thanh tua): highlight nhảy đúng trong ≤ 0,5 giây (SC-005)
    await page.evaluate((ms) => {
      document.querySelector('audio')!.currentTime = ms / 1000;
    }, timeline[3]!.startMs + 200);
    await expect.poll(async () => (await snapshot(page)).active, { timeout: 500 }).toBe(3);

    // 4) Tua về đầu → đoạn đầu
    await page.evaluate(() => {
      document.querySelector('audio')!.currentTime = 0;
    });
    await expect.poll(async () => (await snapshot(page)).active, { timeout: 500 }).toBe(0);

    // 5) Bấm vào câu thứ 2: phát từ đầu câu đó
    await page.getByText(LINES[1]!).click();
    await expect.poll(async () => (await snapshot(page)).paused, { timeout: 5000 }).toBe(false);
    const clicked = await snapshot(page);
    expect(clicked.tMs).toBeGreaterThanOrEqual(timeline[1]!.startMs - 50);
    expect(clicked.tMs).toBeLessThan(timeline[1]!.startMs + 1500);
    // highlight chuyển sang câu vừa bấm trong ≤ 0,8 giây (cho React vẽ lại, đặc biệt trên thiết bị chậm)
    await expect.poll(async () => (await snapshot(page)).active, { timeout: 800 }).toBe(1);

    // 6) Có thể tải voice và chuyển giữa các tab văn bản
    await expect(page.getByRole('link', { name: /Tải voice/ })).toHaveAttribute('href', new RegExp(`/api/voices/${voiceId}/audio\\?download=true`));
    await page.getByRole('tab', { name: 'Kịch bản gốc' }).click();
    await expect(page.getByText(LINES[4]!).first()).toBeVisible();
  });

  test('kịch bản dài: tự cuộn để đoạn đang đọc luôn nằm trong vùng nhìn thấy', async ({ page, request }) => {
    await setupProvider(page);
    const user = uniqueUser('scroll');
    await registerViaApi(request, user);
    await loginViaUi(page, user);
    const lines = Array.from({ length: 30 }, (_, i) => `Đây là câu số ${i + 1} của một kịch bản khá dài.`);
    const { projectId, voiceId, timeline } = await makeVoice(page, lines);
    await page.goto(`/projects/${projectId}/voices/${voiceId}`);
    await expect(page.getByTestId('synced-text')).toBeVisible();

    // Tua tới gần cuối rồi phát: đoạn đang đọc phải được cuộn vào giữa vùng nhìn thấy
    const target = 26;
    await page.evaluate((ms) => {
      const a = document.querySelector('audio')!;
      a.currentTime = ms / 1000;
    }, timeline[target]!.startMs + 100);
    await page.getByTestId('play-toggle').click();
    await expect.poll(async () => (await snapshot(page)).active, { timeout: 3000 }).toBeGreaterThanOrEqual(target);
    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            const box = document.querySelector('[data-testid="synced-text"]') as HTMLElement;
            const el = box.querySelector('[data-active="true"]') as HTMLElement | null;
            if (!el) return false;
            const b = box.getBoundingClientRect();
            const r = el.getBoundingClientRect();
            return r.top >= b.top - 1 && r.bottom <= b.bottom + 1;
          }),
        { timeout: 4000 },
      )
      .toBe(true);
  });

  test('voice không tồn tại hoặc của người khác → thông báo thân thiện, không lộ gì', async ({ page, request }) => {
    const user = uniqueUser('novoice');
    await registerViaApi(request, user);
    await loginViaUi(page, user);
    await page.goto('/projects/00000000-0000-4000-8000-000000000000/voices/00000000-0000-4000-8000-000000000000');
    await expect(page.getByText('Không tìm thấy voice này')).toBeVisible();
  });
});
