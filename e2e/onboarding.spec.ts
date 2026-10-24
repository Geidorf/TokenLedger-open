import type { Page } from '@playwright/test';
import { expect, expectNoHorizontalOverflow, test } from './fixtures';

// 首次启动：`?fresh=1` 让开发 mock 扮演一台刚装好的电脑（本机账本、云端账户、模型接入都是空的），
// 第一次扫描后示例账本才出现。`?fresh=gateway` 同样是新电脑，但模型接入已经打开。
async function openFresh(page: Page, hash: string, fresh: '1' | 'gateway' = '1') {
  await page.goto(`/?fresh=${fresh}#${hash}`);
  await expect(page.locator('main').first()).toBeVisible();
}

test.describe('首次启动引导', () => {
  test('新电脑自动弹出引导，扫描后第一步完成、概览出现数据', async ({ page, ipc }) => {
    await openFresh(page, 'dashboard');
    const dialog = page.getByRole('dialog', { name: '欢迎使用 TokenLedger' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('listitem')).toHaveCount(4);
    await expectNoHorizontalOverflow(page);

    await dialog.getByRole('button', { name: '扫描本机日志' }).click();
    await expect(dialog.getByText(/已读到 [\d,]+ 条记录/)).toBeVisible();
    expect(await ipc.calls('refresh_scan')).toHaveLength(1);
  });

  test('去供应商页添加时收起到右下角，点开回到清单；跳过后刷新不再出现', async ({ page }) => {
    await openFresh(page, 'dashboard', 'gateway');
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: '添加供应商' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('button', { name: '添加第一个供应商' })).toBeVisible();

    const chip = page.getByRole('region', { name: '新手引导' });
    await chip.getByRole('button', { name: /开始使用：已完成 0\/4 步/ }).click();
    await expect(page.getByRole('dialog')).toBeVisible();

    await page.getByRole('button', { name: '跳过引导' }).click();
    await expect(page.getByRole('dialog')).toBeHidden();
    await page.reload();
    await expect(page.locator('main').first()).toBeVisible();
    await expect(page.getByRole('dialog')).toBeHidden();
    await expect(chip).toBeHidden();
  });

  test('已有数据的电脑不弹引导，设置里可以重新打开', async ({ page }) => {
    await page.goto('/#settings-data');
    await expect(page.getByRole('dialog')).toBeHidden();
    await page.getByRole('button', { name: '打开新手引导' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText(/已读到 [\d,]+ 条记录/)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('region', { name: '新手引导' })).toBeVisible();
  });
});

test.describe('无数据空状态', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => window.localStorage.setItem('tokenledger.onboarding.v1', 'dismissed'));
  });

  test('请求、会话、额度页给出下一步', async ({ page }) => {
    await openFresh(page, 'records');
    await expect(page.getByText('本机还没有请求记录')).toBeVisible();
    await openFresh(page, 'behavior');
    await expect(page.getByText('本机还没有会话记录')).toBeVisible();
    await openFresh(page, 'allowances');
    await expect(page.getByText('还没有额度数据')).toBeVisible();
    await expect(page.getByRole('button', { name: '去设置授权' })).toBeVisible();
  });

  test('网关各页没有供应商时都指向添加供应商', async ({ page }) => {
    await openFresh(page, 'agents', 'gateway');
    await expect(page.getByText('还没有可选的模型')).toBeVisible();
    await page.getByRole('main').getByRole('button', { name: '添加供应商' }).first().click();
    await expect(page.getByText('还没有供应商', { exact: true })).toBeVisible();

    await openFresh(page, 'gateway', 'gateway');
    await expect(page.getByText('还没有可用模型')).toBeVisible();
    await expect(page.getByText('还没有经过网关的请求').first()).toBeVisible();

    await openFresh(page, 'routing', 'gateway');
    await expect(page.getByText('还没有路由组')).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });
});
