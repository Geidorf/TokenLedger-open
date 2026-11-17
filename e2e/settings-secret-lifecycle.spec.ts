import { expect, expectNoHorizontalOverflow, openPage, test } from './fixtures';

// 仅用开发 IPC mock 与虚构密码，验证隐藏分区不会保留敏感输入。
for (const viewport of [{ width: 1200, height: 800 }, { width: 1280, height: 860 }]) {
  test.describe(`设置敏感草稿 ${viewport.width}×${viewport.height}`, () => {
    test.use({ viewport });

    test('额度分区往返保留名称与地址，丢弃 key；保存失败也丢弃 key', async ({ page, ipc }) => {
      await openPage(page, 'settings-quota');
      const name = page.getByLabel('公司额度来源名称', { exact: true });
      const url = page.getByLabel('公司额度查询接口地址', { exact: true });
      const key = page.getByLabel('公司额度 API key', { exact: true });
      await name.fill('QA 草稿');
      await url.fill('https://quota.example.test/v1/quota');
      await key.fill('qa-key-not-real');
      const nav = page.getByRole('navigation', { name: '设置分区' });
      await nav.getByRole('button', { name: /^扫描与启动/ }).click();
      await expect(key).toBeHidden();
      await nav.getByRole('button', { name: /^订阅额度/ }).click();
      await expect(key).toHaveValue('');
      await expect(name).toHaveValue('QA 草稿');
      await expect(url).toHaveValue('https://quota.example.test/v1/quota');
      await ipc.override('upsert_custom_quota_endpoint', { error: 'qa-save-denied' });
      await key.fill('qa-second-key-not-real');
      await key.locator('xpath=ancestor::form').getByRole('button', { name: /添加.*额度/ }).click();
      await expect(page.getByText('qa-save-denied', { exact: true })).toBeVisible();
      await expect(key).toHaveValue('');
      await expect(name).toHaveValue('QA 草稿');
      await expectNoHorizontalOverflow(page);
    });

    test('数据分区往返与失败提交清空密码，保留普通目录和用户名', async ({ page, ipc }) => {
      await openPage(page, 'settings-data');
      const peer = page.locator('.settings-card').filter({ hasText: '外部网关 WebDAV 同步' });
      const backup = page.locator('.settings-card').filter({ hasText: '备份与迁移' });
      await peer.getByLabel('用户名', { exact: true }).fill('qa-user');
      await peer.getByLabel('WebDAV 地址', { exact: true }).fill('https://dav.example.test/dav');
      await peer.getByLabel('WebDAV 密码', { exact: true }).fill('qa-password');
      await peer.getByLabel('外部网关同步密码', { exact: true }).fill('qa-passphrase');
      await backup.getByLabel('备份文件夹', { exact: true }).fill('/tmp/qa-backup-draft');
      await backup.getByLabel('备份密码', { exact: true }).first().fill('qa-export-password');
      await backup.getByLabel('再输一次密码', { exact: true }).fill('qa-export-password');
      const nav = page.getByRole('navigation', { name: '设置分区' });
      await nav.getByRole('button', { name: /^扫描与启动/ }).click();
      await nav.getByRole('button', { name: /^数据与帮助/ }).click();
      await expect(peer.getByLabel('用户名', { exact: true })).toHaveValue('qa-user');
      await expect(backup.getByLabel('备份文件夹', { exact: true })).toHaveValue('/tmp/qa-backup-draft');
      for (const input of await peer.locator('input[type=password]').all()) await expect(input).toHaveValue('');
      for (const input of await backup.locator('input[type=password]').all()) await expect(input).toHaveValue('');

      await ipc.override('peer_sync_save_config', { error: 'qa-peer-denied' });
      await peer.getByLabel('WebDAV 密码', { exact: true }).fill('qa-password');
      await peer.getByLabel('外部网关同步密码', { exact: true }).fill('qa-passphrase');
      await peer.getByRole('button', { name: '保存', exact: true }).click();
      await expect(peer.getByRole('alert')).toContainText('qa-peer-denied');
      for (const input of await peer.locator('input[type=password]').all()) await expect(input).toHaveValue('');

      await ipc.override('local_backup_export', { error: 'qa-export-denied' });
      await backup.getByLabel('备份密码', { exact: true }).first().fill('qa-export-password');
      await backup.getByLabel('再输一次密码', { exact: true }).fill('qa-export-password');
      await backup.getByRole('button', { name: '导出加密备份', exact: true }).click();
      await expect(backup.getByRole('alert')).toContainText('qa-export-denied');
      await expect(backup.getByLabel('备份密码', { exact: true }).first()).toHaveValue('');
      await expect(backup.getByLabel('再输一次密码', { exact: true })).toHaveValue('');
      await expectNoHorizontalOverflow(page);
    });

    test('Webhook 保存失败清除带 token 地址和签名密钥，名称保留', async ({ page, ipc }) => {
      await ipc.override('save_alert_webhook', { error: 'qa-webhook-denied' });
      await openPage(page, 'settings-budget');
      const card = page.locator('.settings-card').filter({ hasText: '推送到群聊与 Webhook' });
      await card.getByLabel('Webhook 名称').fill('QA 草稿群');
      await card.getByLabel('Webhook 地址').fill('https://open.feishu.cn/open-apis/bot/v2/hook/qa-not-real');
      await card.getByLabel('签名密钥（可选）').fill('qa-not-real');
      await card.getByRole('button', { name: '添加 Webhook' }).click();
      await expect(card.getByRole('alert')).toContainText('qa-webhook-denied');
      await expect(card.getByLabel('Webhook 地址')).toHaveValue('');
      await expect(card.getByLabel('签名密钥（可选）')).toHaveValue('');
      await expect(card.getByLabel('Webhook 名称')).toHaveValue('QA 草稿群');
      await expectNoHorizontalOverflow(page);
    });
  });
}
