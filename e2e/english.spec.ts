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
      await expect(page.getByRole('main').getByRole('button', { name: 'Scan local logs' })).toBeVisible();
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

  test('路由页：新建路由组、按权重与会话保持都是英文', async ({ page }) => {
    await openEnglish(page, 'routing');
    await expect(page.getByRole('navigation', { name: 'Main pages' })).toContainText('Providers');
    await expect(page.getByRole('heading', { name: 'Routing', level: 1 })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Live routing' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Recent decisions' })).toBeVisible();
    await page.getByRole('button', { name: /New routing group/ }).click();
    const dialog = page.getByRole('dialog', { name: 'New routing group' });
    await dialog.getByLabel('Name').fill('Split');
    await dialog.getByLabel('Choose a member').selectOption('openai/gpt-5');
    await dialog.getByRole('button', { name: /Add member/ }).click();
    await dialog.getByLabel(/^Distribution/).selectOption('weighted');
    await expect(dialog.getByText('New sessions are split by weight; on failure members are tried from highest weight down')).toBeVisible();
    await expect(dialog.getByLabel('Weight of openai/gpt-5')).toBeVisible();
    await expect(dialog.getByLabel(/^Session affinity/)).toContainText('1 h');
    await expectNoHorizontalOverflow(page);
  });

  test('供应商页与 Agent 页：列表、编辑表单与健康度是英文', async ({ page }) => {
    await openEnglish(page, 'providers');
    await expect(page.getByText(/^3 enabled · 1 without a key/)).toBeVisible();
    await page.getByRole('button', { name: /^DeepSeek/ }).first().click();
    const sheet = page.getByRole('dialog', { name: /DeepSeek/ });
    await expect(sheet.getByText('Upstream protocol')).toBeVisible();
    await expect(sheet.getByRole('region', { name: 'DeepSeek health' })).toBeVisible();
    await expect(sheet.getByRole('button', { name: 'Delete provider' })).toBeVisible();
    await sheet.getByRole('button', { name: 'Close' }).click();
    await page.getByRole('button', { name: 'Add provider' }).click();
    await expect(page.getByText('Pick a preset and paste a key')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'China vendors' })).toBeVisible();
    await openEnglish(page, 'agents');
    await expect(page.getByText(/models and routing groups · agent configs get only the gateway URL/)).toBeVisible();
    await page.getByRole('button', { name: 'Setup steps' }).last().click();
    const manual = page.getByRole('dialog', { name: 'Claude Desktop manual setup' });
    await expect(manual.getByText(/Gateway base URL: Enter the root URL without \/v1/)).toBeVisible();
    await expect(manual.getByText('Model list', { exact: true })).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });

  test('额度页：订阅额度面板、重置时间与待处理来源是英文', async ({ page }) => {
    await openEnglish(page, 'allowances');
    const panel = page.locator('section.quota-panel');
    await expect(panel.getByRole('heading', { name: /Plan quotas/ })).toBeVisible();
    await expect(panel.getByText('Remaining', { exact: true })).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Refresh quotas' })).toBeVisible();
    await expect(panel.getByText(/^Resets /).first()).toBeVisible();
    await expect(panel.getByText('Sources to set up')).toBeVisible();
    await expect(panel.getByRole('progressbar', { name: '5-hour available' })).toHaveAttribute('aria-valuetext', '80% available');
    await expectNoHorizontalOverflow(page);
  });

  test('网关页：接入说明、模型目录与最近请求是英文', async ({ page }) => {
    await openEnglish(page, 'gateway');
    await expect(page.getByRole('heading', { name: /^Connect/ })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Model catalog' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Copy local token' })).toBeVisible();
    await expect(page.getByRole('heading', { name: /^Recent requests/ })).toBeVisible();
    await expect(page.getByText('Effective tokens = input + output; cache reads and writes are listed separately')).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });

  test('用量页顶栏：子页、数据范围与主题都是英文', async ({ page }) => {
    await openEnglish(page, 'dashboard');
    await expect(page.getByRole('navigation', { name: 'Usage pages' })).toContainText('Allowances');
    await expect(page.getByRole('group', { name: 'Data scope' })).toContainText('Cloud total');
    await expect(page.getByRole('button', { name: 'Settings & cloud' }).first()).toBeVisible();
  });

  test('请求明细：筛选、汇总与表头是英文', async ({ page }) => {
    await openEnglish(page, 'records');
    await expect(page.getByRole('region', { name: 'Usage detail filters' })).toContainText('Filters');
    await expect(page.getByRole('group', { name: 'Time range' })).toContainText('Custom');
    await expect(page.getByRole('button', { name: 'Tool: All Tools' })).toBeVisible();
    await expect(page.getByLabel('Search tools, models, devices or sessions')).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Estimated cost' })).toBeAttached();
    await expect(page.getByRole('button', { name: 'Expand this record' }).first()).toBeVisible();
    await page.getByRole('button', { name: 'Expand this record' }).first().click();
    await expect(page.getByText('Full timestamp')).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });

  test('行为分析：范围栏、指标、图表与排行是英文', async ({ page }) => {
    await openEnglish(page, 'behavior');
    await expect(page.getByRole('group', { name: 'Behavior analysis time range' })).toContainText('Last 7 days');
    await expect(page.getByText('Effective tokens', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Active days', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: /^Daily activity/ })).toBeVisible();
    await expect(page.getByRole('heading', { name: /^Top tools/ })).toBeVisible();
    await expect(page.getByRole('heading', { name: /^Top sessions/ })).toBeVisible();
    await expect(page.getByText(/^Local coverage:/)).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });

  test('设置：订阅额度整页是英文', async ({ page }) => {
    await openEnglish(page, 'settings-quota');
    await expect(page.getByRole('heading', { name: 'Subscription quota' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Quota setup overview' })).toContainText('Local subscriptions connected');
    await expect(page.getByText('Read Codex quota', { exact: true })).toBeVisible();
    await expect(page.getByText('One-click setup', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Quota alerts', { exact: true })).toBeVisible();
    await expect(page.getByText('Provider balances', { exact: true })).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });

  test('概览：核心指标卡与趋势卡是英文', async ({ page }) => {
    await openEnglish(page, 'dashboard');
    const metrics = page.getByRole('region', { name: 'Key metrics' });
    await expect(metrics).toContainText('Effective tokens');
    await expect(metrics).toContainText('Estimated cost');
    await expect(metrics).toContainText('Records');
    await expect(page.getByRole('region', { name: 'Trends and comparison' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Switch to cost view' })).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });

  test('概览：模型费用分布与模型专属看板是英文', async ({ page }) => {
    await openEnglish(page, 'dashboard');
    const open = page.locator('.model-cost-drilldown-btn').first();
    await expect(open).toHaveAccessibleName(/^Open the .+ dashboard$/);
    await open.scrollIntoViewIfNeeded();
    await open.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('Model dashboard');
    await expect(dialog).toContainText(/Period: /);
    await expect(dialog).toContainText('Active days');
    await expect(dialog.getByRole('group', { name: 'Breakdown measure' })).toBeVisible();
    await expect(dialog).toContainText('Recent records');
    await expect(dialog).not.toContainText(/[\u4e00-\u9fff]/);
    await dialog.getByRole('button', { name: 'Close dashboard' }).click();
    await expect(dialog).toBeHidden();
  });

  test('概览：用量拆分与设置目录是英文', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 860 });
    await openEnglish(page, 'dashboard');
    await page.locator('main').getByRole('button', { name: 'Year', exact: true }).click();
    const split = page.locator('section.usage-split');
    await split.scrollIntoViewIfNeeded();
    await expect(split).toContainText('Usage split');
    await split.locator('.usage-split-pick', { hasText: 'codex' }).first().click();
    await expect(split.getByRole('status')).toContainText('Only Agent codex');
    await split.getByRole('group', { name: 'Split by' }).getByRole('button', { name: 'Model' }).click();
    await expect(split.getByRole('group', { name: 'Split metric' }).getByRole('button', { name: 'Cost' })).toBeDisabled();
    await split.getByRole('button', { name: 'Show all' }).click();
    await expect(split.getByRole('status')).toHaveCount(0);
    await expect(split).not.toContainText(/[\u4e00-\u9fff]/);

    await page.goto('/?lang=en#settings-data');
    await expect(page.getByRole('searchbox', { name: 'Search settings' })).toBeVisible();
    await expect(page.getByText('Switches and intervals save automatically', { exact: false })).toBeVisible();
  });

  test('设置：云端账户与壁纸是英文', async ({ page }) => {
    await openEnglish(page, 'settings-cloud');
    await expect(page.getByRole('heading', { name: 'Cloud account' })).toBeVisible();
    await expect(page.getByText('Connection progress')).toBeVisible();
    await expect(page.getByLabel('Email', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Password', { exact: true })).toBeVisible();
    await openEnglish(page, 'settings-wallpaper');
    await expect(page.getByRole('heading', { name: 'Wallpaper', exact: true })).toBeVisible();
    await expect(page.getByText('Desktop status')).toBeVisible();
    await expect(page.getByText('Wallpaper usage source')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Clean up old wallpapers' })).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });

  test('设置：手机动态壁纸与其他电脑的共享用量卡片是英文', async ({ page }) => {
    await openEnglish(page, 'settings-data');
    await expect(page.getByText('Shared usage from other computers')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Show computers sharing usage' })).toBeVisible();
    // 重复计数警示在英文下也要保留。
    await expect(page.getByText(/Only tick computers without TokenLedger installed/)).toBeVisible();
  });

  test('设置：预算提醒、外部网关同步与按项目统计是英文', async ({ page }) => {
    await openEnglish(page, 'settings-budget');
    await expect(page.getByRole('switch', { name: 'Alert when nearing or over budget' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add budget' })).toBeVisible();
    await openEnglish(page, 'settings-data');
    await expect(page.getByText('External gateway WebDAV sync')).toBeVisible();
    await expect(page.getByRole('switch', { name: 'Count local usage by project' })).toBeVisible();
  });
});
