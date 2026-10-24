import { expect, expectNoHorizontalOverflow, openPage, test } from './fixtures';

// 设置 › 预算提醒 › 推送到群聊与 Webhook：默认关；地址只发给后端，页面上只剩域名；
// 测试发送的结果显示在这一行下面。
test.describe('设置：提醒推送到 Webhook', () => {
  test('添加飞书机器人、打开推送、测试发送，地址不回显', async ({ page, ipc }) => {
    await openPage(page, 'settings-budget');
    const card = page.locator('.settings-card').filter({ hasText: '推送到群聊与 Webhook' });
    await card.scrollIntoViewIfNeeded();
    await expect(card.getByText('还没有 Webhook')).toBeVisible();
    const toggle = card.getByRole('switch', { name: '推送提醒到 Webhook' });
    await expect(toggle).toHaveAttribute('aria-checked', 'false');

    await card.getByLabel('Webhook 名称').fill('值班群');
    await card.getByLabel('Webhook 地址').fill('https://open.feishu.cn/open-apis/bot/v2/hook/e2e-token');
    await card.getByLabel('签名密钥（可选）').fill('SECe2e');
    await card.getByRole('button', { name: '添加 Webhook' }).click();
    await expect(card.getByText('值班群')).toBeVisible();
    await expect(card.getByText(/飞书 · open\.feishu\.cn · 已签名/)).toBeVisible();
    await expect(page.locator('body')).not.toContainText('e2e-token');
    const saves = await ipc.calls('save_alert_webhook');
    expect((saves.at(-1)!.args as { input: unknown }).input).toEqual(expect.objectContaining({
      platform: 'feishu', includeCost: false, kinds: ['budget', 'quota', 'anomaly', 'periodReport'],
    }));

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    // 预览里额度与异常提醒的系统通知是关的，卡片要提示推送不会发生。
    await expect(card.getByRole('note')).toContainText('额度窗口、用量异常');

    await card.getByRole('button', { name: '测试发送到 值班群' }).click();
    await expect(card.getByRole('status')).toHaveText('已发送测试消息，去群里看看是否收到。');
    await expect(card.getByText(/测试成功/)).toBeVisible();
  });

  test('企业微信不显示签名密钥；窄窗不横向滚动', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 900 });
    await openPage(page, 'settings-budget');
    const card = page.locator('.settings-card').filter({ hasText: '推送到群聊与 Webhook' });
    await card.getByLabel('Webhook 平台').selectOption('wecom');
    await expect(card.getByLabel('签名密钥（可选）')).toHaveCount(0);
    await card.scrollIntoViewIfNeeded();
    await expectNoHorizontalOverflow(page);
  });
});
