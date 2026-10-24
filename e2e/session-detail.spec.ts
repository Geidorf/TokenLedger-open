import { expect, openPage, test } from './fixtures';

// 用量 › 会话 › 会话详情。`preview-session-refactor` 是 devMockSessionDetail 的预览会话：
// 34 次经网关的请求，三次模型切换，带耗时与 Context 构成。

test.describe('会话详情', () => {
  test.use({ viewport: { width: 1280, height: 860 } });

  test('从会话排行打开详情，返回后回到列表', async ({ page }) => {
    await openPage(page, 'sessions');
    await page.getByRole('button', { name: /查看该会话明细/ }).first().click();
    const detail = page.getByTestId('session-detail');
    await expect(detail.getByRole('heading', { name: '会话详情' })).toBeVisible();
    await expect(page).toHaveURL(/#session\//);
    await expect(detail.getByText('请求时间线')).toBeVisible();
    await detail.getByRole('button', { name: '返回会话列表' }).click();
    await expect(detail).toHaveCount(0);
    await expect(page).toHaveURL(/#sessions$/);
  });

  test('预览会话：概要、同类对比、最贵请求跳到时间线', async ({ page }) => {
    await openPage(page, 'session/claude/preview-session-refactor');
    const detail = page.getByTestId('session-detail');
    const stats = detail.locator('.session-detail-stats');
    await expect(stats).toContainText('模型切换');
    await expect(stats).toContainText('34');
    await expect(detail.locator('.session-detail-chart').first()).toBeVisible();
    await expect(detail.getByText('34 次请求带构成')).toBeVisible();
    await expect(detail.locator('.session-detail-peer')).toContainText('同类平均');
    await expect(detail.locator('.session-detail-switch')).toHaveCount(2);

    const first = detail.locator('.session-detail-top button').first();
    await expect(first).toContainText('claude-opus-4-1');
    await first.click();
    await expect(detail.locator('tr.is-highlighted')).toHaveCount(1);
    await expect(detail.locator('tr.is-highlighted')).toBeFocused();
  });

  test('请求明细的展开行能打开会话详情，详情能回到按会话筛选的明细', async ({ page }) => {
    await openPage(page, 'requests');
    await page.locator('.log-detail-toggle').first().click();
    await page.getByRole('button', { name: /打开会话 .* 的详情/ }).first().click();
    const detail = page.getByTestId('session-detail');
    await expect(detail.getByText('请求时间线')).toBeVisible();
    const sessionId = (await detail.locator('.session-detail-id').textContent())!;
    await detail.getByRole('button', { name: '在请求明细中查看' }).click();
    await expect(page.locator('#details-page-title')).toBeVisible();
    await expect(page.getByRole('textbox', { name: /搜索/ }).first()).toHaveValue(sessionId);
  });

  test('概览的「会话异常昂贵」卡片打开该会话的详情', async ({ page }) => {
    await openPage(page, 'dashboard');
    const panel = page.locator('.usage-anomaly-panel');
    await panel.scrollIntoViewIfNeeded();
    await panel.getByRole('button', { name: /会话异常昂贵.*查看会话详情/ }).click();
    await expect(page).toHaveURL(/#session\/codex\/mock-session-7f3a$/);
    const detail = page.getByTestId('session-detail');
    await expect(detail.locator('.session-detail-id')).toHaveText('mock-session-7f3a');
    // 预览账本里没有这个会话：如实说明，而不是空白页。
    await expect(detail.getByText('找不到这个会话')).toBeVisible();
  });

  test('英文界面', async ({ page }) => {
    await openPage(page, 'session/claude/preview-session-refactor', '?lang=en');
    const detail = page.getByTestId('session-detail');
    await expect(detail.getByRole('heading', { name: 'Session detail' })).toBeVisible();
    await expect(detail.getByText('Request timeline')).toBeVisible();
    await expect(detail.getByText('Compared with similar sessions')).toBeVisible();
  });
});
