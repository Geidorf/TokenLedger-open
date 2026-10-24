import { expect, openPage, test } from './fixtures';

// 「数据与帮助」里的备份与迁移、数据库体检（契约 local-backup-v1）。

test.describe('设置：备份与迁移', () => {
  test('导出要两次密码一致；恢复先预览，再交回预览摘要合并恢复', async ({ page, ipc }) => {
    await openPage(page, 'settings-data');
    const card = page.locator('.settings-card, section').filter({ hasText: '备份与迁移' }).last();
    await card.scrollIntoViewIfNeeded();
    const exportButton = card.getByRole('button', { name: '导出加密备份' });
    await expect(exportButton).toBeDisabled();
    await card.getByLabel('备份密码').first().fill('long enough');
    await card.getByLabel('再输一次密码').fill('long enough');
    await exportButton.click();
    await expect(card).toContainText(/已导出到 .*\.tlbackup/);
    const exports = await ipc.calls('local_backup_export');
    expect((exports.at(-1)!.args as { input: Record<string, string> }).input.passphrase).toBe('long enough');

    await card.getByRole('button', { name: '列出备份文件夹里的备份' }).click();
    await card.getByRole('radio', { name: /TokenLedger-auto-20261023-090000/ }).check();
    await card.getByLabel('备份密码').nth(1).fill('long enough');
    await card.getByRole('button', { name: '预览备份' }).click();
    await expect(card.getByRole('checkbox', { name: /用量账本/ })).toBeChecked();
    await expect(card.getByRole('checkbox', { name: /价格表/ })).not.toBeChecked();
    await expect(card).toContainText('本机还没有 API key');
    await card.getByRole('button', { name: '恢复选中的部分' }).click();
    await expect(card).toContainText(/已恢复：账本 46,977 行/);
    const applies = await ipc.calls('local_backup_apply');
    const input = (applies.at(-1)!.args as { input: { digest: string; conflict: string; sections: Record<string, boolean> } }).input;
    expect(input).toMatchObject({ digest: 'mock-digest', conflict: 'keepLocal' });
    expect(input.sections).toMatchObject({ ledger: true, prices: false });
  });

  test('数据库体检完好时报告行数，不显示修复', async ({ page }) => {
    await openPage(page, 'settings-data');
    const card = page.locator('.settings-card, section').filter({ hasText: '数据库体检' }).last();
    await card.scrollIntoViewIfNeeded();
    await card.getByRole('button', { name: '检查数据库' }).click();
    await expect(card).toContainText('数据库完好：账本 48,210 行');
    await expect(card.getByRole('button', { name: '修复' })).toHaveCount(0);
  });
});
