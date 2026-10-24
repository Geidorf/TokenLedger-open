import { expect, expectNoHorizontalOverflow, openPage, test } from './fixtures';

// 供应商健康度：只读网关自己的请求记录，供应商行显示徽标与 24 小时趋势条，
// 详情里有成功率、耗时分位与最近失败；路由组成员前有所属供应商的健康圆点。

test.describe('供应商健康度', () => {
  test.use({ viewport: { width: 1280, height: 860 } });

  test('供应商行显示健康徽标与趋势，详情列出统计与最近失败', async ({ page, ipc }) => {
    await openPage(page, 'providers');
    const deepseek = page.locator('.mw-row').filter({ hasText: 'DeepSeek' });
    await expect(deepseek.getByText('降级', { exact: true })).toBeVisible();
    await expect(deepseek.getByRole('img', { name: /DeepSeek近 24 小时 \d+ 次请求/ })).toBeVisible();
    await expect(page.locator('.mw-row').filter({ hasText: 'OpenAI' }).getByText('健康', { exact: true })).toBeVisible();
    // 未设置 key 的供应商请求都没发到上游，判为故障。
    await expect(page.locator('.mw-row').filter({ hasText: 'OpenRouter' }).getByText('故障', { exact: true })).toBeVisible();

    await deepseek.getByRole('button', { name: /DeepSeek/ }).click();
    const health = page.getByRole('region', { name: 'DeepSeek 健康度' });
    await expect(health).toContainText('成功率');
    await expect(health).toContainText('P95 耗时');
    await expect(health).toContainText('最近失败');
    await expect(health).toContainText('冷却中：deepseek/deepseek-chat');
    await expect(health.getByText('HTTP 429', { exact: false }).first()).toBeVisible();
    await expectNoHorizontalOverflow(page);
    expect((await ipc.calls('gateway_provider_health')).length).toBeGreaterThan(0);
  });

  test('路由组成员前显示供应商健康圆点', async ({ page }) => {
    await openPage(page, 'routing');
    const card = page.locator('.mw-group').first();
    await expect(card.getByRole('img', { name: '健康度：降级' })).toBeVisible();
    await expect(card.getByRole('img', { name: '健康度：健康' })).toBeVisible();
  });
});
