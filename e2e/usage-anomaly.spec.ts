import { expect, expectNoHorizontalOverflow, openPage, test } from './fixtures';

// 概览 › 消费洞察 › 用量异常：只在本机范围出现，卡片说明何时、多少、与平时比；
// 通知开关默认关，开启后保存到后端。
test.describe('概览：用量异常', () => {
  test('显示异常卡片、规则说明，并能开启系统通知', async ({ page, ipc }) => {
    await openPage(page, 'dashboard');
    const panel = page.locator('.usage-anomaly-panel');
    await panel.scrollIntoViewIfNeeded();
    await expect(panel.getByText('用量异常', { exact: true })).toBeVisible();
    await expect(panel.getByRole('button', { name: /Token 突增，今天/ })).toBeVisible();
    await expect(panel.getByRole('button', { name: /claude-sonnet-4-5 放量/ })).toBeVisible();
    await expect(panel.getByText('Codex 会话异常昂贵')).toBeVisible();
    await expect(panel.getByText('网关错误率突增：本机没有这类数据')).toBeVisible();

    const toggle = panel.getByRole('switch', { name: '异常时系统通知' });
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    const saves = await ipc.calls('set_usage_anomaly_settings');
    expect((saves.at(-1)!.args as { settings: unknown }).settings).toEqual({ notify: true });
  });

  test('窄窗不横向滚动', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 900 });
    await openPage(page, 'dashboard');
    await page.locator('.usage-anomaly-panel').scrollIntoViewIfNeeded();
    await expect(page.locator('.usage-anomaly-card').first()).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });
});
