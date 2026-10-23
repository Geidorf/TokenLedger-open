import { expect, openPage, test } from './fixtures';

test('刷新扫描发出 refresh_scan 并提示结果', async ({ page, ipc }) => {
  await openPage(page, 'dashboard');
  await page.locator('main').getByRole('button', { name: '刷新并扫描本地日志' }).click();
  await expect(page.getByText('扫描完成，已发现 6 条新记录')).toBeVisible();
  expect(await ipc.calls('refresh_scan')).toHaveLength(1);
});

test('看板取数失败时给出错误态，重试后恢复', async ({ page, ipc }) => {
  await ipc.override('get_cached_stats', { error: '本机数据库被占用' });
  await openPage(page, 'dashboard');
  const alert = page.getByRole('alert').filter({ hasText: '看板数据暂时不可用' });
  await expect(alert).toBeVisible();
  await expect(alert).toContainText('本机数据库被占用');

  await ipc.restore('get_cached_stats');
  await alert.getByRole('button').first().click();
  await expect(alert).toBeHidden();
  await expect(page.locator('main').getByText('有效 Token').first()).toBeVisible();
});

test('后端推送 stats-updated 时重新取数', async ({ page, ipc }) => {
  await openPage(page, 'dashboard');
  await expect(page.locator('main').getByText('有效 Token').first()).toBeVisible();
  const before = (await ipc.calls('get_cached_stats')).length;
  await ipc.emit('stats-updated');
  await expect.poll(async () => (await ipc.calls('get_cached_stats')).length).toBeGreaterThan(before);
});
