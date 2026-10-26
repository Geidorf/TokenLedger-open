import { DEFAULT_SETTINGS } from '../src/types';
import { expect, openPage, test } from './fixtures';

for (const viewport of [{ width: 1200, height: 800 }, { width: 1280, height: 860 }]) {
  test.describe(`登录自启 ${viewport.width}`, () => {
    test.use({ viewport });

    test('系统状态覆盖历史偏好，普通设置不会重新登记', async ({ page, ipc }) => {
      await ipc.override('get_settings', {
        value: { ...DEFAULT_SETTINGS, autostart_enabled: true, start_minimized: false },
      });
      await ipc.override('get_autostart_status', {
        value: { supported: true, enabled: false, error: null },
      });
      await openPage(page, 'settings-scan');
      const autostart = page.getByRole('switch', { name: '开机自动启动', exact: true });
      await expect(autostart).toHaveAttribute('aria-checked', 'false');
      await page.getByRole('switch', { name: '启动时最小化到托盘', exact: true }).click();
      await expect.poll(async () => (await ipc.calls('save_settings')).length).toBe(1);
      await expect(autostart).toHaveAttribute('aria-checked', 'false');
      expect(await ipc.calls('set_autostart_enabled')).toEqual([]);
    });

    test('显式开关使用专用命令并回读系统状态', async ({ page, ipc }, testInfo) => {
      await ipc.override('get_autostart_status', {
        value: { supported: true, enabled: false, error: null },
      });
      await openPage(page, 'settings-scan');
      const toggle = page.getByRole('switch', { name: '开机自动启动', exact: true });
      await expect(toggle).toHaveAttribute('aria-checked', 'false');
      await ipc.override('get_autostart_status', {
        value: { supported: true, enabled: true, error: null },
      });
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-checked', 'true');
      await expect(toggle).toBeEnabled();
      const calls = await ipc.calls('set_autostart_enabled');
      expect(calls.map(call => call.args)).toEqual([{ enabled: true }]);
      expect(await ipc.calls('save_settings')).toEqual([]);
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({ path: testInfo.outputPath('startup-enabled.png'), fullPage: true });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

      await ipc.override('get_autostart_status', {
        value: { supported: true, enabled: false, error: null },
      });
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-checked', 'false');
      expect((await ipc.calls('set_autostart_enabled')).map(call => call.args))
        .toEqual([{ enabled: true }, { enabled: false }]);
    });

    test('程序位置失效时等待显式重新启用，再回读系统状态', async ({ page, ipc }, testInfo) => {
      await ipc.override('get_autostart_status', {
        value: {
          supported: true,
          enabled: null,
          error: '登录启动项指向其他程序位置，请按当前位置重新启用。',
        },
      });
      await openPage(page, 'settings-scan');
      const repair = page.getByRole('button', { name: '按当前位置重新启用', exact: true });
      await expect(repair).toBeVisible();
      await expect(page.getByRole('switch', { name: '开机自动启动', exact: true })).toHaveCount(0);
      expect(await ipc.calls('set_autostart_enabled')).toEqual([]);
      expect(await page.getByRole('alert').evaluate(element =>
        element.scrollHeight <= element.clientHeight + 1,
      )).toBe(true);
      await page.screenshot({ path: testInfo.outputPath('startup-stale-registration.png'), fullPage: true });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

      await ipc.override('get_autostart_status', {
        value: { supported: true, enabled: true, error: null },
      });
      await repair.click();
      await expect(page.getByRole('switch', { name: '开机自动启动', exact: true }))
        .toHaveAttribute('aria-checked', 'true');
      expect((await ipc.calls('set_autostart_enabled')).map(call => call.args))
        .toEqual([{ enabled: true }]);
      expect(await ipc.calls('save_settings')).toEqual([]);
    });

    test('读取可重试，保存失败保持系统状态且不提示成功', async ({ page, ipc }, testInfo) => {
      await ipc.override('get_autostart_status', { error: '系统状态暂不可读取' });
      await openPage(page, 'settings-scan');
      await expect(page.getByRole('switch', { name: '开机自动启动', exact: true })).toHaveCount(0);
      const retry = page.getByRole('button', { name: /重试.*自启|重试.*启动|重试/ });
      await expect(retry).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath('startup-unavailable.png'), fullPage: true });
      await ipc.override('get_autostart_status', {
        value: { supported: true, enabled: false, error: null },
      });
      await retry.click();
      const toggle = page.getByRole('switch', { name: '开机自动启动', exact: true });
      await expect(toggle).toHaveAttribute('aria-checked', 'false');
      await ipc.override('set_autostart_enabled', { error: '登记失败，已恢复原登录启动登记。' });
      await toggle.click();
      await expect(page.getByText(/登记失败，已恢复原登录启动登记/)).toBeVisible();
      await expect(toggle).toBeEnabled();
      await expect(toggle).toHaveAttribute('aria-checked', 'false');
      expect(await ipc.calls('save_settings')).toEqual([]);
    });
  });
}
