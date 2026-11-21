import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 120_000,
  expect: { timeout: 60_000 },
  fullyParallel: true,
  workers: 3,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:4173',
    serviceWorkers: 'block', // test riêng cho PWA tự bật lại; còn lại chặn để mock mạng ổn định
    trace: 'retain-on-failure',
  },
  webServer: { command: 'node scripts/serve.mjs', url: 'http://localhost:4173', reuseExistingServer: true },
  projects: [
    { name: 'iPhone 13', use: { ...devices['iPhone 13'] } }, // WebKit
    { name: 'Pixel 7', use: { ...devices['Pixel 7'] } }, // Chromium
  ],
});
