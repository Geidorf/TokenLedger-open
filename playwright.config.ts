import { defineConfig, devices } from '@playwright/test';

// 桌面前端浏览器级回归。页面跑在 Vite 开发服务器上，后端由 src/devMockTauri.ts
// 的 IPC mock 提供；单个用例的覆盖数据见 e2e/fixtures.ts。说明见 e2e/README.md。
const PORT = Number(process.env.TOKENLEDGER_E2E_PORT ?? 1430);
const BASE_URL = `http://127.0.0.1:${PORT}`;

// 截图基线只在 Linux Chromium 上生成与校验：字体光栅化随操作系统变化，
// 跨平台比对只会制造噪声。其它项目照常跑功能与布局断言。
const desktopChrome = { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 860 } };
const desktopSafari = { ...devices['Desktop Safari'], viewport: { width: 1280, height: 860 } };

export default defineConfig({
  testDir: 'e2e',
  outputDir: 'test-results/e2e',
  snapshotPathTemplate: '{testDir}/__screenshots__/{testFilePath}/{arg}{ext}',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  timeout: 45_000,
  expect: {
    timeout: 10_000,
    toHaveScreenshot: { maxDiffPixelRatio: 0.01, animations: 'disabled', caret: 'hide', scale: 'css' },
  },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]] : 'list',
  use: {
    baseURL: BASE_URL,
    timezoneId: 'Asia/Shanghai',
    colorScheme: 'light',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium-zh', use: { ...desktopChrome, locale: 'zh-CN' } },
    { name: 'chromium-en', use: { ...desktopChrome, locale: 'en-US' } },
    { name: 'webkit-zh', use: { ...desktopSafari, locale: 'zh-CN' } },
    { name: 'webkit-en', use: { ...desktopSafari, locale: 'en-US' } },
  ],
  webServer: {
    command: `npx vite --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
