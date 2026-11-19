import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT ?? 3100);

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    locale: 'vi-VN',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    // Viewport điện thoại 375 px (FR-031): chỉ chạy các test gắn thẻ @mobile
    {
      name: 'mobile',
      grep: /@mobile/,
      use: { ...devices['Desktop Chrome'], viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true },
    },
  ],
  // scripts/e2e-up.ts tạo CSDL + bucket E2E riêng, rồi chạy web (đã build) và worker.
  webServer: process.env.E2E_NO_SERVER
    ? undefined
    : {
        command: 'npm run build && npx tsx scripts/e2e-up.ts',
        url: `http://localhost:${PORT}/login`,
        reuseExistingServer: false,
        timeout: 420_000,
        stdout: 'pipe',
        stderr: 'pipe',
      },
});
