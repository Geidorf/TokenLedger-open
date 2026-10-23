import { expect, openPage, test } from './fixtures';

// 用量分析的两处交互：概览的用量拆分（点一行即只看这一项，热力图随之切换）
// 与请求子页的「导出 CSV」（按当前筛选取全部行，交给后端写文件）。

test('用量拆分：选中 Agent 后模型列表收窄，热力图换成该 Agent', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await openPage(page, 'dashboard');
  // 热力图只在「今年」「总计」这类长范围出现。
  await page.locator('main').getByRole('button', { name: '今年', exact: true }).click();
  const split = page.locator('section.usage-split');
  await split.scrollIntoViewIfNeeded();
  await split.locator('.usage-split-pick', { hasText: 'codex' }).first().click();
  await expect(split.getByRole('status')).toContainText('只看Agent codex');
  await expect(page.getByText(/^codex · /).first()).toBeVisible();

  await split.getByRole('group', { name: '拆分维度' }).getByRole('button', { name: '模型' }).click();
  // Agent × 模型只有有效 Token，请求与费用指标此时禁用。
  await expect(split.getByRole('group', { name: '拆分指标' }).getByRole('button', { name: '费用' })).toBeDisabled();
  await expect(split.locator('.usage-split-pick').first()).toBeVisible();

  await split.getByRole('button', { name: '显示全部' }).click();
  await expect(split.getByRole('status')).toHaveCount(0);
});

test('请求子页导出 CSV：交给后端的是带表头的全部行', async ({ page, ipc }) => {
  await openPage(page, 'records');
  await page.getByRole('button', { name: '导出 CSV' }).click();
  await expect(page.getByText(/已导出 \d+ 条记录/)).toBeVisible();
  const [call] = await ipc.calls('export_usage_csv');
  const content = String((call.args as { content?: string } | undefined)?.content ?? '');
  const lines = content.trimEnd().split('\n');
  expect(lines[0]).toMatch(/^time,tool,model,/);
  expect(lines.length).toBeGreaterThan(1);
});
