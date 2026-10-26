import { en } from '../src/i18n/en';
import { zh } from '../src/i18n/zh';
import { expect, expectNoHorizontalOverflow, openPage, test } from './fixtures';

for (const viewport of [{ width: 1200, height: 800 }, { width: 1280, height: 860 }]) {
  test(`内容采样确认、按需阅读与关闭清理 ${viewport.width}`, async ({ page, ipc }, info) => {
    const english = info.project.name.endsWith('-en');
    const messages = english ? en : zh;
    await page.setViewportSize(viewport);
    await openPage(page, 'gateway', english ? '?lang=en' : '?lang=zh');
    const samplingSwitch = page.getByRole('switch', { name: messages['sampling.switchLabel'] });
    await expect(samplingSwitch).toHaveAttribute('aria-checked', 'false');
    await samplingSwitch.click();
    const confirmation = page.getByRole('alertdialog', { name: messages['sampling.enable.title'] });
    const enable = confirmation.getByRole('button', { name: messages['sampling.enable.action'], exact: true });
    await expect(enable).toBeDisabled();
    expect(await ipc.calls('gateway_set_content_sampling')).toHaveLength(0);
    await confirmation.getByRole('checkbox', { name: messages['sampling.confirm'] }).check();
    await enable.click();
    await expect(samplingSwitch).toHaveAttribute('aria-checked', 'true');
    expect((await ipc.calls('gateway_set_content_sampling'))[0].args).toMatchObject({
      input: { mode: 'next', count: 20, confirmed: true },
    });
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: info.outputPath(`sampling-gateway-${viewport.width}.png`), fullPage: true });

    await page.getByRole('button', { name: messages['gateway.requests.openLog'] }).click();
    const firstRequest = page.getByRole('table').first().getByRole('row').nth(1);
    const expand = firstRequest.getByRole('button', { expanded: false });
    await expand.click();
    const sample = page.getByRole('region', { name: messages['requestLog.sample.section'] });
    await expect(sample).toBeVisible();
    expect(await ipc.calls('gateway_read_content_sample')).toHaveLength(0);
    await sample.getByRole('button', { name: messages['requestLog.sample.read'], exact: true }).click();
    const requestBody = sample.getByLabel(messages['requestLog.sample.requestAria']);
    const responseBody = sample.getByLabel(messages['requestLog.sample.responseAria']);
    await expect(requestBody).toContainText('••••');
    await expect(requestBody).not.toContainText('1234567890abcdef');
    await expect(responseBody).not.toContainText('abcdef1234567890');
    await sample.getByRole('button', { name: messages['requestLog.sample.reveal'], exact: true }).click();
    await expect(requestBody).toContainText('1234567890abcdef');
    expect((await ipc.calls('gateway_read_content_sample'))[0].args).toEqual({ id: 'r6' });
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: info.outputPath(`sampling-detail-${viewport.width}.png`), fullPage: true });

    await firstRequest.getByRole('button', { expanded: true }).click();
    await expect(sample).toHaveCount(0);
    await firstRequest.getByRole('button', { expanded: false }).click();
    await expect(sample.getByRole('button', { name: messages['requestLog.sample.read'], exact: true })).toBeVisible();
    await page.getByRole('switch', { name: messages['sampling.switchLabel'] }).click();
    const stop = page.getByRole('alertdialog', { name: messages['sampling.stop.title'] });
    await expect(stop.getByRole('checkbox', { name: messages['sampling.stop.deleteExisting'] })).toBeChecked();
    await stop.getByRole('button', { name: messages['sampling.stop.actionDelete'], exact: true }).click();
    await expect(page.getByRole('switch', { name: messages['sampling.switchLabel'] })).toHaveAttribute('aria-checked', 'false');
    await expect(sample).toHaveCount(0);
    expect((await ipc.calls('gateway_set_content_sampling')).at(-1)?.args).toMatchObject({
      input: { mode: 'off', deleteExisting: true },
    });
  });
}
