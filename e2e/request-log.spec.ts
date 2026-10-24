import { expect, expectNoHorizontalOverflow, openPage, test } from './fixtures';

// 网关请求日志：开发预览的模拟账本里有一条先 429 再切换成功的组请求（r5）、
// 一条命中规则的组请求（r6）、一条直连请求和一条 401 失败。

test.describe('网关请求日志', () => {
  test.use({ viewport: { width: 1280, height: 860 } });

  test('从网关页进入，切换过的请求展开后有尝试顺序与解释链', async ({ page }) => {
    await openPage(page, 'gateway');
    await page.getByRole('button', { name: '打开请求日志' }).click();
    await expect(page.getByRole('heading', { name: '请求日志' })).toBeVisible();
    const table = page.getByRole('table', { name: '网关请求日志' });
    await expect(table.getByRole('row')).toHaveCount(5);
    const switched = table.getByRole('row').filter({ hasText: '切换 1' });
    await expect(switched).toContainText('deepseek/deepseek-chat');
    await switched.getByRole('button', { name: /展开/ }).click();
    const attempts = page.getByRole('region', { name: '尝试顺序' }).getByRole('listitem');
    await expect(attempts).toHaveCount(2);
    await expect(attempts.first()).toContainText('429');
    await expect(page.getByRole('list', { name: 'group/coding 成员决策' })).toContainText('限流');
    await expect(page.getByRole('list', { name: 'Context 构成' })).toContainText('工具定义');
    await expectNoHorizontalOverflow(page);
  });

  test('筛选、搜索与导出带上同一组条件', async ({ page, ipc }) => {
    await openPage(page, 'gatewaylog');
    const table = page.getByRole('table', { name: '网关请求日志' });
    await expect(table.getByRole('row')).toHaveCount(5);
    await page.getByRole('combobox', { name: '状态' }).selectOption('error');
    await expect(table.getByRole('row')).toHaveCount(2);
    await expect(table).toContainText('401');
    await page.getByRole('combobox', { name: '状态' }).selectOption('');
    await page.getByRole('textbox', { name: '搜索请求日志' }).fill('reasoner');
    await expect(table.getByRole('row')).toHaveCount(2);
    await page.getByRole('button', { name: '导出 CSV' }).click();
    await expect(page.getByText(/已导出 1 条请求/)).toBeVisible();
    const [call] = await ipc.calls('gateway_request_log_export');
    expect(call.args).toMatchObject({ query: { search: 'reasoner' } });
    await page.getByRole('textbox', { name: '搜索请求日志' }).fill('没有这个');
    await expect(page.getByText('没有符合条件的请求')).toBeVisible();
  });

  test('实时尾随按间隔重新读取', async ({ page, ipc }) => {
    await openPage(page, 'gatewaylog');
    await expect(page.getByRole('table', { name: '网关请求日志' })).toBeVisible();
    await page.getByRole('button', { name: '实时尾随' }).click();
    await expect(page.getByRole('button', { name: '尾随中' })).toHaveAttribute('aria-pressed', 'true');
    const before = (await ipc.calls('gateway_request_log')).length;
    await expect.poll(async () => (await ipc.calls('gateway_request_log')).length, { timeout: 8000 }).toBeGreaterThan(before);
  });

  test('420 宽度不横向滚动', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 860 });
    await openPage(page, 'gatewaylog');
    await expect(page.getByRole('table', { name: '网关请求日志' })).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });
});
