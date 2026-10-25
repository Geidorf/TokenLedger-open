import type { Page } from '@playwright/test';
import { expect, expectNoHorizontalOverflow, openPage, test, type IpcFixture } from './fixtures';
import type { BudgetRule, BudgetStatus, BudgetStatusReport } from '../src/hooks/useBudget';

// 设置 › 预算提醒：新增一条预算后列表显示用量进度，保存的是规范化后的规则。
test.describe('设置：预算提醒', () => {
  test('新增本月全部费用预算，列表显示进度并能停用、删除', async ({ page, ipc }) => {
    await openPage(page, 'settings-budget');
    await expect(page.getByText('还没有预算')).toBeVisible();
    await expect(page.getByRole('switch', { name: '接近或超出预算时提醒' })).toHaveAttribute('aria-checked', 'false');

    await page.getByLabel('预算上限').fill('0.01');
    await page.getByRole('button', { name: '添加预算' }).click();
    const meter = page.getByRole('meter', { name: '本月 · 全部用量 · 预估费用已用比例' });
    await expect(meter).toBeVisible();
    await expect(meter).toHaveAttribute('aria-valuenow', '100');
    await expect(page.locator('.budget-rule')).toHaveAttribute('data-level', 'over');
    const saves = await ipc.calls('set_budget_settings');
    expect((saves.at(-1)!.args as { settings: { rules: unknown[] } }).settings.rules).toEqual([
      expect.objectContaining({ period: 'month', metric: 'cost', scopeKind: 'all', scopeId: '', limit: 0.01, warnPercent: 80, enabled: true }),
    ]);

    await page.getByRole('button', { name: '停用' }).click();
    await expect(page.locator('.budget-rule')).toHaveAttribute('data-enabled', 'false');
    await page.getByRole('button', { name: /^删除 / }).click();
    await expect(page.getByText('还没有预算')).toBeVisible();
  });

  test('按 Agent 设 Token 预算时给出本月出现过的 Agent 作为建议；窄窗不横向滚动', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 900 });
    await openPage(page, 'settings-budget');
    await page.getByLabel('预算范围').selectOption('tool');
    const options = page.locator('datalist option');
    expect(await options.count()).toBeGreaterThan(0);
    const first = await options.first().getAttribute('value');
    await page.getByLabel('预算Agent').fill(first!);
    await page.getByLabel('预算口径').selectOption('tokens');
    await page.getByLabel('预算上限').fill('1000000000000');
    await page.getByRole('button', { name: '添加预算' }).click();
    await expect(page.locator('.budget-rule')).toHaveAttribute('data-level', 'ok');
    await expectNoHorizontalOverflow(page);
  });
});

const OVERVIEW_RULE: BudgetRule = {
  id: 'overview-month',
  enabled: true,
  period: 'month',
  metric: 'cost',
  scopeKind: 'all',
  scopeId: '',
  limit: 50,
  warnPercent: 80,
};

const OVERVIEW_STATUS: BudgetStatus = {
  ruleId: OVERVIEW_RULE.id,
  periodStart: '2026-07-01',
  used: 75,
  limit: 50,
  percent: 150,
  level: 'over',
};

function overviewReport(statuses: BudgetStatus[]): BudgetStatusReport {
  return {
    generatedAt: '2026-07-15T06:30:00Z',
    statuses,
    choices: { tools: [], models: [], providers: [], providersAvailable: false },
    phoneSync: { state: 'off', lastPublishedAt: null, error: null },
  };
}

async function configureOverview(ipc: IpcFixture, rules = [OVERVIEW_RULE], statuses = [OVERVIEW_STATUS]) {
  await ipc.override('get_budget_settings', { value: { notify: false, syncToPhone: false, rules } });
  await ipc.override('get_budget_status', { value: overviewReport(statuses) });
}

async function openBudgetOverview(page: Page, lang: 'zh' | 'en' = 'zh') {
  await openPage(page, 'dashboard', `?lang=${lang}`);
  await page.getByRole('radiogroup', { name: '概览布局' }).getByRole('radio', { name: '省钱', exact: true }).click();
  const card = page.locator('.budget-overview-card');
  await expect(card).toBeVisible();
  return card;
}

test.describe('概览：预算进度', () => {
  test('通知关闭仍展示启用规则，超额保留实际比例，未知读数不冒充零', async ({ page, ipc }) => {
    const unknownRule = { ...OVERVIEW_RULE, id: 'overview-unknown', period: 'week' as const };
    const unknownStatus = { ...OVERVIEW_STATUS, ruleId: unknownRule.id, used: null, percent: null, level: 'unavailable' as const };
    await configureOverview(ipc, [OVERVIEW_RULE, unknownRule, { ...OVERVIEW_RULE, id: 'disabled', enabled: false }],
      [OVERVIEW_STATUS, unknownStatus]);
    const card = await openBudgetOverview(page);
    await expect(card.locator('.budget-overview-rule')).toHaveCount(2);
    await expect(card.getByRole('meter')).toHaveCount(1);
    const over = card.locator('.budget-overview-rule').first();
    await expect(over).toContainText('150%');
    await expect(over.getByRole('meter')).toHaveAttribute('aria-valuenow', '100');
    await expect(over.getByRole('meter')).toHaveAttribute('aria-valuetext', /150%/);
    const unknown = card.locator('.budget-overview-rule').nth(1);
    await expect(unknown).toContainText('不可得');
    await expect(unknown.getByRole('meter')).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
  });

  test('扫描后读数更新，刷新失败撤下旧进度，重试后恢复', async ({ page, ipc }) => {
    await configureOverview(ipc);
    const card = await openBudgetOverview(page);
    await expect(card).toContainText('150%');

    await ipc.override('get_budget_status', {
      value: overviewReport([{ ...OVERVIEW_STATUS, used: 45, percent: 90, level: 'warn' }]),
    });
    await ipc.emit('stats-updated');
    await expect(card).toContainText('90%');
    await expect(card).not.toContainText('150%');

    await ipc.override('get_budget_status', { error: 'synthetic budget read failure' });
    await ipc.emit('stats-updated');
    await expect(card.getByRole('alert')).toBeVisible();
    await expect(card.getByRole('meter')).toHaveCount(0);
    await expect(card).not.toContainText('90%');

    await ipc.override('get_budget_status', {
      value: overviewReport([{ ...OVERVIEW_STATUS, used: 0, percent: 0, level: 'ok' }]),
    });
    await card.getByRole('button', { name: /重试/ }).click();
    await expect(card.getByRole('alert')).toHaveCount(0);
    await expect(card.getByRole('meter')).toHaveAttribute('aria-valuenow', '0');
  });

  test('设置读取失败可重试恢复，空状态仍可进入预算设置', async ({ page, ipc }) => {
    await configureOverview(ipc, [], []);
    await ipc.override('get_budget_settings', { error: 'synthetic settings read failure' });
    const card = await openBudgetOverview(page);
    await expect(card.getByRole('alert')).toBeVisible();
    await expect(card.getByRole('meter')).toHaveCount(0);
    await ipc.override('get_budget_settings', { value: { notify: false, syncToPhone: false, rules: [] } });
    await card.getByRole('button', { name: /重试/ }).click();
    await expect(card.getByRole('alert')).toHaveCount(0);
    await expect(card).toContainText('还没有启用的预算');
    await card.getByRole('button', { name: '设置预算' }).click();
    await expect(page).toHaveURL(/#settings-budget$/);
    await expect(page.getByLabel('预算上限')).toBeVisible();
  });

  test('切换日期或云端视图后仍明确展示本机账本与规则自身周期', async ({ page, ipc }) => {
    await configureOverview(ipc);
    const card = await openBudgetOverview(page);
    await expect(card).toContainText('150%');
    await expect(card).toContainText('全部设备');
    await expect(card).toContainText('自身周期');

    const week = page.locator('[data-range-control]').getByRole('button', { name: '本周', exact: true });
    await week.click();
    await expect(week).toHaveAttribute('aria-pressed', 'true');
    await expect(card.getByRole('meter', { name: /本月/ })).toBeVisible();
    await expect(card).toContainText('150%');

    await page.getByRole('button', { name: '去设置与云端检查云端状态' }).click();
    await expect(page.getByRole('button', { name: '退出云端账户' })).toBeEnabled();
    await page.getByRole('navigation', { name: '主要页面导航' }).getByRole('button', { name: '用量', exact: true }).click();
    await expect(card).toContainText('150%');
    const cloud = page.getByRole('group', { name: '数据范围', exact: true }).getByRole('button', { name: '云端汇总' });
    await cloud.click();
    await expect(cloud).toHaveAttribute('aria-pressed', 'true');
    await expect(card).toContainText('本机预算');
    await expect(card).toContainText('全部设备');
    await expect(card.getByRole('meter', { name: /本月/ })).toBeVisible();
    await expect(card).toContainText('150%');
  });

  for (const fixture of [
    { width: 1200, height: 800, lang: 'zh' as const, theme: 'light' as const },
    { width: 1280, height: 860, lang: 'en' as const, theme: 'dark' as const },
    { width: 420, height: 860, lang: 'zh' as const, theme: 'light' as const },
    { width: 420, height: 860, lang: 'en' as const, theme: 'dark' as const },
  ]) {
    test(`${fixture.lang} 预算卡片在 ${fixture.width}×${fixture.height} ${fixture.theme} 布局可读`, async ({ page, ipc }, testInfo) => {
      await page.setViewportSize({ width: fixture.width, height: fixture.height });
      await page.emulateMedia({ colorScheme: fixture.theme });
      await configureOverview(ipc, [
        OVERVIEW_RULE,
        { ...OVERVIEW_RULE, id: 'long-model', scopeKind: 'model', scopeId: 'fixture-model-with-a-long-name-for-wrapping-0123456789' },
      ], [
        OVERVIEW_STATUS,
        { ...OVERVIEW_STATUS, ruleId: 'long-model', used: null, percent: null, level: 'unavailable' },
      ]);
      const card = await openBudgetOverview(page, fixture.lang);
      await expect(page.locator('html')).toHaveAttribute('data-theme', fixture.theme);
      await expect(card).toContainText('150%');
      if (fixture.lang === 'en') await expect(card).not.toContainText(/[\u3400-\u9fff]/);
      await expectNoHorizontalOverflow(page);
      const overflow = await card.evaluate(element => element.scrollWidth - element.clientWidth);
      expect(overflow).toBeLessThanOrEqual(1);
      for (const button of await card.getByRole('button').all()) {
        const box = await button.boundingBox();
        expect(box?.height).toBeGreaterThanOrEqual(44);
        expect(box?.width).toBeGreaterThanOrEqual(44);
      }
      await card.screenshot({ path: testInfo.outputPath('budget-overview.png'), animations: 'disabled' });
    });
  }
});
