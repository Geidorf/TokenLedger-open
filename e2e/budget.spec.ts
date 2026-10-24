import { expect, expectNoHorizontalOverflow, openPage, test } from './fixtures';

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
