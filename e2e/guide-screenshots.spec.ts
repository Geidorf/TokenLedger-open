import type { Page } from '@playwright/test';
import { expect, openPage, test } from './fixtures';

// 用户手册（docs/guide/）配图。不是回归用例：平时跳过，需要重新生成配图时运行
//
//   TOKENLEDGER_GUIDE_SHOTS=1 npx playwright test --project=chromium-zh e2e/guide-screenshots.spec.ts
//
// 画面全部来自开发 mock 的示例数据（src/devMockTauri.ts），不含任何真实用户的数据。
// 设置 › 数据与帮助里有一行外部导入入口的名称不宜进手册配图，所以那一节不截。
const OUT = 'docs/guide/images';

interface Shot {
  name: string;
  hash: string;
  query?: string;
  dark?: boolean;
  width?: number;
  height?: number;
  prepare?: (page: Page) => Promise<void>;
}

const SHOTS: Shot[] = [
  { name: 'first-run', hash: 'dashboard', query: '?fresh=1', prepare: async (page) => {
    await expect(page.getByRole('dialog')).toBeVisible();
  } },
  { name: 'first-run-en', hash: 'dashboard', query: '?fresh=1&lang=en', prepare: async (page) => {
    await expect(page.getByRole('dialog')).toBeVisible();
  } },
  { name: 'usage-overview', hash: 'dashboard' },
  { name: 'usage-overview-dark', hash: 'dashboard', dark: true },
  { name: 'usage-requests', hash: 'records' },
  { name: 'usage-sessions', hash: 'behavior' },
  { name: 'usage-quota', hash: 'allowances' },
  { name: 'agents', hash: 'agents' },
  { name: 'providers', hash: 'providers' },
  { name: 'gateway', hash: 'gateway' },
  { name: 'routing', hash: 'routing', height: 1100 },
  { name: 'settings-scan', hash: 'settings-scan' },
  { name: 'settings-cloud', hash: 'settings-cloud' },
  { name: 'settings-quota', hash: 'settings-quota' },
  { name: 'settings-budget', hash: 'settings-budget', prepare: async (page) => {
    // 两条示例预算：今日费用已超出，本月费用接近上限。
    await addBudget(page, { period: 'day', limit: '15' });
    await addBudget(page, { period: 'month', limit: '320' });
    await expect(page.locator('.budget-rule')).toHaveCount(2);
  } },
  { name: 'settings-widgets', hash: 'settings-widget', height: 1000 },
  { name: 'settings-wallpaper', hash: 'settings-wallpaper' },
  { name: 'tray-widget', hash: '', query: '?view=widget', width: 364, height: 414 },
];

async function addBudget(page: Page, { period, limit }: { period: 'day' | 'week' | 'month'; limit: string }) {
  await page.getByLabel('预算周期').selectOption(period);
  await page.getByLabel('预算上限').fill(limit);
  await page.getByRole('button', { name: '添加预算' }).click();
}

test.describe('用户手册配图', () => {
  test.beforeEach(() => {
    test.skip(!process.env.TOKENLEDGER_GUIDE_SHOTS, '只在重新生成手册配图时运行');
    test.skip(test.info().project.name !== 'chromium-zh', '配图只用 Chromium 中文项目生成');
  });

  for (const shot of SHOTS) {
    test(shot.name, async ({ page }) => {
      await page.setViewportSize({ width: shot.width ?? 1280, height: shot.height ?? 860 });
      await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: shot.dark ? 'dark' : 'light' });
      if (shot.query?.includes('view=widget')) {
        await page.goto(`/${shot.query}`);
      } else {
        await openPage(page, shot.hash, shot.query);
      }
      await page.evaluate(() => document.fonts.ready);
      await page.waitForLoadState('networkidle');
      if (shot.prepare) await shot.prepare(page);
      await page.screenshot({ path: `${OUT}/${shot.name}.png`, animations: 'disabled', caret: 'hide' });
    });
  }
});
