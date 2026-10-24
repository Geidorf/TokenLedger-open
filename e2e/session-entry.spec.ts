import type { BehaviorAnalysisResponse } from '../src/types';
import type { RequestLogPage } from '../src/features/gateway/types';
import { builtInIpc, expect, expectNoHorizontalOverflow, openPage, reloadSettled, test } from './fixtures';

const SESSION = 'preview-session-refactor';
const layouts = [
  { width: 1200, height: 800, lang: 'zh' },
  { width: 1280, height: 860, lang: 'en' },
] as const;

for (const layout of layouts) {
  const openLabel = layout.lang === 'en'
    ? `Open details of session ${SESSION}`
    : `打开会话 ${SESSION} 的详情`;
  const backLabel = layout.lang === 'en' ? 'Back to sessions' : '返回会话列表';

  test(`报告会话入口 ${layout.width} ${layout.lang}`, async ({ page, ipc }, testInfo) => {
    await page.setViewportSize(layout);
    await openPage(page, 'reports', `?lang=${layout.lang}`);
    const behavior = await builtInIpc<BehaviorAnalysisResponse>(page, 'get_local_behavior_analysis');
    await ipc.override('get_local_behavior_analysis', {
      value: {
        ...behavior,
        sessions: [{
          id: SESSION, tool: 'claude', tokens: 12000, requests: 3, cost: 0.5,
          firstAt: '2026-07-06 09:00:00', lastAt: '2026-07-06 10:00:00', topModel: 'fixture-model',
        }],
      },
    });
    await reloadSettled(page);
    const card = page.getByRole('region', { name: '最贵的会话' });
    const entry = card.getByRole('button', { name: openLabel, exact: true });
    await expect(entry).toBeVisible();
    await expect(card).toContainText(layout.lang === 'en' ? 'full local session' : '完整会话');
    await card.scrollIntoViewIfNeeded();
    await expectNoHorizontalOverflow(page);
    await testInfo.attach('report-session-entry', {
      body: await page.screenshot(), contentType: 'image/png',
    });
    await entry.click();
    await expect(page).toHaveURL(/#session\/claude\/preview-session-refactor$/);
    const detail = page.getByTestId('session-detail');
    await expect(detail.locator('.session-detail-id')).toHaveText(SESSION);
    await expect(detail.locator('.session-detail-chart').first()).toBeVisible();
    const reads = await ipc.calls('get_usage_details');
    expect(reads.at(-1)?.args).toMatchObject({
      query: { scope: 'local', range: 'all', tools: ['claude'], search: SESSION },
    });
    await detail.getByRole('button', { name: backLabel, exact: true }).click();
    await expect(page).toHaveURL(/#sessions$/);
  });

  test(`请求日志会话入口 ${layout.width} ${layout.lang}`, async ({ page, ipc }, testInfo) => {
    await page.setViewportSize(layout);
    await openPage(page, 'gatewaylog', `?lang=${layout.lang}`);
    const log = await builtInIpc<RequestLogPage>(page, 'gateway_request_log', { query: {} });
    await ipc.override('gateway_request_log', {
      value: {
        ...log,
        entries: [{ ...log.entries[0], agent: ' claude-code ', session: ` ${SESSION} ` }],
        total: 1,
      },
    });
    await reloadSettled(page);
    const table = page.getByRole('table');
    await table.locator('.mw-log-toggle').first().click();
    const entry = page.getByRole('button', { name: openLabel, exact: true });
    await expect(entry).toBeVisible();
    await expect(page.locator('.mw-log-detail')).toContainText(
      layout.lang === 'en' ? 'full local session' : '完整会话',
    );
    await entry.scrollIntoViewIfNeeded();
    await expectNoHorizontalOverflow(page);
    await testInfo.attach('request-log-session-entry', {
      body: await page.screenshot(), contentType: 'image/png',
    });
    await entry.focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/#session\/claude\/preview-session-refactor$/);
    const detail = page.getByTestId('session-detail');
    await expect(detail.locator('.session-detail-id')).toHaveText(SESSION);
    await expect(detail.locator('.session-detail-chart').first()).toBeVisible();
    const reads = await ipc.calls('get_usage_details');
    expect(reads.at(-1)?.args).toMatchObject({
      query: { scope: 'local', range: 'all', tools: ['claude'], search: SESSION },
    });
  });
}
