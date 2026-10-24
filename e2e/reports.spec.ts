import { expect, expectNoHorizontalOverflow, openPage, test } from './fixtures';

// 用量 › 报告：上周周报对比前一周，导出 HTML 与图片，提醒开关写回后端。
test.describe('用量：周报与月报', () => {
  test('默认打开上周周报，汇总与拆分齐全并能导出', async ({ page, ipc }) => {
    await openPage(page, 'reports');
    await expect(page.getByRole('heading', { name: '用量周报 · 7月6日—7月12日' })).toBeVisible();
    await expect(page.getByText('对比前一周（06-29 至 07-05）')).toBeVisible();
    await expect(page.getByRole('region', { name: '按 Agent' }).getByText('Codex')).toBeVisible();
    await expect(page.getByRole('region', { name: '最贵的会话' }).locator('li')).toHaveCount(5);

    const stats = await ipc.calls('get_cached_stats');
    const ranges = stats.map((call) => {
      const args = call.args as { range: string; start: string | null; end: string | null };
      return `${args.range}:${args.start}..${args.end}`;
    });
    expect(ranges).toEqual(expect.arrayContaining(['custom:2026-07-06..2026-07-12', 'custom:2026-06-29..2026-07-05']));

    const [html] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'HTML', exact: true }).click()]);
    expect(html.suggestedFilename()).toBe('tokenledger-weekly-2026-07-06_2026-07-12.html');
    const [image] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '图片', exact: true }).click()]);
    expect(image.suggestedFilename()).toBe('tokenledger-weekly-2026-07-06_2026-07-12.png');
  });

  test('切到月报看上月；提醒开关保存到后端；窄窗不横向滚动', async ({ page, ipc }) => {
    await page.setViewportSize({ width: 720, height: 900 });
    await openPage(page, 'reports');
    await page.getByRole('button', { name: '月报' }).click();
    await expect(page.getByRole('heading', { name: '用量月报 · 2026年6月' })).toBeVisible();
    const reminder = page.getByRole('switch', { name: '每月 1 日提醒' });
    await expect(reminder).toHaveAttribute('aria-checked', 'false');
    await reminder.click();
    await expect(reminder).toHaveAttribute('aria-checked', 'true');
    const saves = await ipc.calls('set_period_report_settings');
    expect((saves.at(-1)!.args as { settings: unknown }).settings).toEqual({ weekly: true, monthly: true });
    await expectNoHorizontalOverflow(page);
  });
});
