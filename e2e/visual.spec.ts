import { expect, openPage, test } from './fixtures';

// 少量整页视觉基线，作为后续信息架构与视觉改版的安全网。基线只在 Linux Chromium
// 中文项目上生成与比对（见 playwright.config.ts）；改版有意改变画面时用
// `npm run test:e2e:update` 重新生成并在 PR 里说明。
const SHOTS = [
  { name: 'dashboard-1280', hash: 'dashboard', width: 1280 },
  { name: 'records-1280', hash: 'records', width: 1280 },
  { name: 'gateway-1280', hash: 'gateway', width: 1280 },
  { name: 'settings-1280', hash: 'settings-scan', width: 1280 },
  { name: 'dashboard-420', hash: 'dashboard', width: 420 },
  // 英文界面：新电脑的首次启动引导（`?lang=en` 与设置里选 English 等价）。
  { name: 'onboarding-en-1280', hash: 'dashboard', width: 1280, query: '?fresh=1&lang=en' },
  { name: 'routing-en-1280', hash: 'routing', width: 1280, query: '?lang=en' },
  { name: 'gateway-en-1280', hash: 'gateway', width: 1280, query: '?lang=en' },
  { name: 'records-en-1280', hash: 'records', width: 1280, query: '?lang=en' },
] as const satisfies readonly { name: string; hash: string; width: number; query?: string }[];

test.describe('视觉基线', () => {
  test.beforeEach(() => {
    test.skip(test.info().project.name !== 'chromium-zh' || process.platform !== 'linux', '基线只在 Linux Chromium 中文项目上比对');
  });

  for (const shot of SHOTS) {
    const { name, hash, width } = shot;
    const query = 'query' in shot ? shot.query : undefined;
    test(name, async ({ page }) => {
      await page.setViewportSize({ width, height: 860 });
      // 关掉数字滚动与图表入场动画，截图只反映稳定画面。
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await openPage(page, hash, query);
      await page.evaluate(() => document.fonts.ready);
      await page.waitForLoadState('networkidle');
      await expect(page).toHaveScreenshot(`${name}.png`);
    });
  }
});
