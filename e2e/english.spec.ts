import type { Page } from '@playwright/test';
import { expect, expectNoHorizontalOverflow, test } from './fixtures';

// 英文界面：已迁到文案表（src/i18n）的页面在 English 下整段换成英文，选择记在本机。
// 地址里的 `?lang=en` 与设置里选 English 等价；`?fresh=1` 的含义见 onboarding.spec.ts。
async function openEnglish(page: Page, hash: string, fresh?: '1' | 'gateway') {
  const query = fresh ? `?fresh=${fresh}&lang=en` : '?lang=en';
  await page.goto(`/${query}#${hash}`);
  await expect(page.locator('main').first()).toBeVisible();
}

test.describe('英文界面', () => {
  test('新电脑的首次启动引导整份是英文，扫描后读数按英文格式', async ({ page }) => {
    await openEnglish(page, 'dashboard', '1');
    const dialog = page.getByRole('dialog', { name: 'Welcome to TokenLedger' });
    await expect(dialog).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(dialog.getByText('Turn on cloud sync')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Skip guide' })).toBeVisible();
    await expectNoHorizontalOverflow(page);

    await dialog.getByRole('button', { name: 'Scan local logs' }).click();
    await expect(dialog.getByText(/^Found [\d,]+ records\./)).toBeVisible();

    await dialog.getByRole('button', { name: 'Minimize the setup guide' }).click();
    await expect(page.getByRole('region', { name: 'Getting started' }).getByRole('button', { name: /1\/4 steps done/ })).toBeVisible();
  });

  test('引导里切回中文立即生效，刷新后仍是中文', async ({ page }) => {
    await openEnglish(page, 'dashboard', '1');
    await page.getByRole('combobox', { name: 'Interface language' }).selectOption('zh');
    await expect(page.getByRole('dialog', { name: '欢迎使用 TokenLedger' })).toBeVisible();
    await page.goto('/?fresh=1#dashboard');
    await expect(page.getByRole('dialog', { name: '欢迎使用 TokenLedger' })).toBeVisible();
  });

  test('设置 › 数据与帮助里选 English，引导卡片跟着换', async ({ page }) => {
    await page.goto('/#settings-data');
    await page.getByRole('combobox', { name: '界面语言' }).selectOption('en');
    await expect(page.getByRole('button', { name: 'Open setup guide' })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('combobox', { name: 'Interface language' })).toHaveValue('en');
  });

  test.describe('空状态', () => {
    test.beforeEach(async ({ page }) => {
      await page.addInitScript(() => window.localStorage.setItem('tokenledger.onboarding.v1', 'dismissed'));
    });

    test('会话与额度页', async ({ page }) => {
      await openEnglish(page, 'behavior', '1');
      await expect(page.getByText('No local sessions yet')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Scan local logs' })).toBeVisible();
      await openEnglish(page, 'allowances', '1');
      await expect(page.getByText('No quota data yet')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Authorize in Settings' })).toBeVisible();
    });

    test('Agent 与供应商页', async ({ page }) => {
      await openEnglish(page, 'agents', 'gateway');
      await expect(page.getByText('No models to choose from yet')).toBeVisible();
      await page.getByRole('main').getByRole('button', { name: 'Add a provider' }).click();
      await expect(page.getByText('No providers yet', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Add your first provider' })).toBeVisible();
      await expectNoHorizontalOverflow(page);
    });
  });
});
