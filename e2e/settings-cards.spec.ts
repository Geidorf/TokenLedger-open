import type { AppSettings } from '../src/types';
import { builtInIpc, expect, openPage, test } from './fixtures';

// 设置页今晚新增的两张卡片：「桌面挂件」里的手机动态壁纸开关（把实时路由同步到手机），
// 「数据与帮助」里的其他电脑共享用量（按电脑勾选，默认一台都不统计）。

test.describe('设置：手机动态壁纸', () => {
  test('默认关闭；打开后保存设置并显示同步状态，关掉后说明会删除云端快照', async ({ page, ipc }) => {
    await openPage(page, 'settings-widget');
    const card = page.locator('.settings-card, section').filter({ hasText: '手机动态壁纸' }).last();
    const toggle = page.getByRole('switch', { name: /^把实时路由同步到手机/ });
    await toggle.scrollIntoViewIfNeeded();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await expect(card).toContainText('关闭时不上传任何路由数据，并删除云端本机那一份快照。');
    expect(await ipc.calls('routing_publish_status')).toHaveLength(0);

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await expect(card).toContainText(/已同步（刚刚），当前 3 条路由记录/);
    const saves = await ipc.calls('save_settings');
    expect((saves.at(-1)!.args as { settings: Record<string, unknown> }).settings).toMatchObject({ routing_publish_enabled: true });

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await expect(card).toContainText('关闭时不上传任何路由数据');
  });

  test('云端未部署与未登录各自如实说明', async ({ page, ipc }) => {
    await ipc.override('routing_publish_status', { value: { state: 'not-deployed', lastPublishedAt: null, flows: 0, error: null } });
    await openPage(page, 'settings-widget');
    const settings = await builtInIpc<AppSettings>(page, 'get_settings');
    await ipc.override('get_settings', { value: { ...settings, routing_publish_enabled: true } });
    await page.reload();
    const toggle = page.getByRole('switch', { name: /^把实时路由同步到手机/ });
    await toggle.scrollIntoViewIfNeeded();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByText('云端尚未部署实时路由同步（需要执行一次数据库迁移），其他同步不受影响。')).toBeVisible();

    await ipc.override('routing_publish_status', { value: { state: 'signed-out', lastPublishedAt: null, flows: 0, error: null } });
    await page.reload();
    await expect(page.getByText('需要先在「云端同步」登录账户，手机端登录同一个账户才能看到。')).toBeVisible();
  });
});

test.describe('设置：其他电脑的共享用量', () => {
  test('列出电脑默认不勾选；勾选后统计，提交的只有选中的电脑', async ({ page, ipc }) => {
    await openPage(page, 'settings-data');
    const card = page.locator('.settings-card, section').filter({ hasText: '其他电脑的共享用量' }).last();
    await card.getByRole('button', { name: '查看共享用量的电脑' }).scrollIntoViewIfNeeded();
    await card.getByRole('button', { name: '查看共享用量的电脑' }).click();

    const list = card.getByLabel('共享用量的电脑');
    const box = list.getByRole('checkbox');
    await expect(box).toHaveCount(1);
    await expect(box).not.toBeChecked();
    await expect(list).toContainText('studio-mac');
    await expect(list).toContainText('41 天');
    await expect(card.getByRole('button', { name: '不统计任何电脑' })).toBeVisible();

    await box.check();
    await card.getByRole('button', { name: '统计选中的 1 台电脑' }).click();
    await expect(card.getByRole('status')).toContainText('已统计 1 台电脑的 1280 次调用');
    const [pull] = await ipc.calls('peer_sync_shared_pull');
    expect(pull.args).toEqual({ ids: ['3f9a1c0e5b7d2468'] });
  });

  test('停止统计并清除不依赖服务器；读取失败时显示原因', async ({ page, ipc }) => {
    await ipc.override('peer_sync_shared_list', { error: 'WebDAV 连接失败：401' });
    await openPage(page, 'settings-data');
    const card = page.locator('.settings-card, section').filter({ hasText: '其他电脑的共享用量' }).last();
    await card.getByRole('button', { name: '查看共享用量的电脑' }).scrollIntoViewIfNeeded();
    await card.getByRole('button', { name: '查看共享用量的电脑' }).click();
    await expect(card.getByRole('alert')).toHaveText('WebDAV 连接失败：401');

    await card.getByRole('button', { name: '停止统计并清除' }).click();
    await expect(card.getByRole('status')).toHaveText('已停止统计其他电脑的用量，并删除了本机保存的副本。');
    expect(await ipc.calls('peer_sync_shared_clear')).toHaveLength(1);
  });

  test('WebDAV 上没有其他电脑时给出说明', async ({ page, ipc }) => {
    await ipc.override('peer_sync_shared_list', { value: { computers: [], last: null } });
    await openPage(page, 'settings-data');
    const card = page.locator('.settings-card, section').filter({ hasText: '其他电脑的共享用量' }).last();
    await card.getByRole('button', { name: '查看共享用量的电脑' }).scrollIntoViewIfNeeded();
    await card.getByRole('button', { name: '查看共享用量的电脑' }).click();
    await expect(card.getByRole('status')).toHaveText('WebDAV 上还没有其他电脑共享的用量。');
    await expect(card.getByRole('checkbox')).toHaveCount(0);
  });
});
