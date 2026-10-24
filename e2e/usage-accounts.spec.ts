import type { Page } from '@playwright/test';
import { builtInIpc, expect, openPage, reloadSettled, test, type IpcFixture } from './fixtures';
import type { StatsData, UsageDetailsResponse } from '../src/types';

// 用量分析今晚新增的两处：拆分的「账号」维度（按网关供应商汇总本机用量）与
// 请求展开行的「Context 构成」。devMockTauri 默认不带账号与构成，这里在内置回包上补字段。

const account = (name: string, input: number, output: number, requests: number, cost: number) => ({
  name, input, output, cached: 0, cacheRead: 0, cacheWrite: 0, total: input + output, cost, requests,
  heatmap: { '2026-07-14': input + output },
  heatmapRequests: { '2026-07-14': requests },
  heatmapCost: { '2026-07-14': cost },
});

const yearButton = (page: Page) => page.locator('main').getByRole('button', { name: '今年', exact: true });

/**
 * 打开概览、切到「今年」（热力图只在长范围出现），拿到这个范围的内置统计，
 * 补上两个账号后重新加载。统计回包的 meta 必须与当前筛选一致，所以按范围取。
 */
async function withAccounts(page: Page, ipc: IpcFixture) {
  await openPage(page, 'dashboard');
  await yearButton(page).click();
  await expect.poll(async () => (await ipc.calls('get_cached_stats')).some(call => (call.args as { range?: string }).range === 'year')).toBe(true);
  const call = (await ipc.calls('get_cached_stats')).reverse().find(item => (item.args as { range?: string }).range === 'year')!;
  const stats = await builtInIpc<StatsData>(page, 'get_cached_stats', call.args as Record<string, unknown>);
  await ipc.override('get_cached_stats', { value: {
    ...stats,
    providers: { 'deepseek-main': account('deepseek-main', 90_000, 30_000, 120, 0.42), 'openai-team': account('openai-team', 40_000, 10_000, 30, 1.25) },
  } });
  await reloadSettled(page);
  if (await yearButton(page).getAttribute('aria-pressed') !== 'true') await yearButton(page).click();
}

test.describe('用量拆分：账号维度', () => {
  test.use({ viewport: { width: 1280, height: 860 } });

  test('没有网关记录时账号按钮禁用并说明原因', async ({ page }) => {
    await openPage(page, 'dashboard');
    const split = page.locator('section.usage-split');
    const button = split.getByRole('group', { name: '拆分维度' }).getByRole('button', { name: '账号' });
    await expect(button).toBeDisabled();
    await expect(button).toHaveAttribute('title', /账号来自网关供应商/);
  });

  test('有账号时按账号拆分，三项指标都可选，选中后只看该账号', async ({ page, ipc }) => {
    await withAccounts(page, ipc);
    const split = page.locator('section.usage-split');
    await split.scrollIntoViewIfNeeded();
    await split.getByRole('group', { name: '拆分维度' }).getByRole('button', { name: '账号' }).click();
    await expect(split.getByText('账号即网关供应商，只含经网关转发与导入的记录')).toBeVisible();
    const metrics = split.getByRole('group', { name: '拆分指标' });
    for (const label of ['记录数', '费用']) await expect(metrics.getByRole('button', { name: label })).toBeEnabled();

    const picks = split.locator('.usage-split-pick');
    await expect(picks).toHaveCount(2);
    // 默认按 Token 降序：deepseek-main（12 万）在 openai-team（5 万）之前。
    await expect(picks.first()).toContainText('deepseek-main');
    await metrics.getByRole('button', { name: '费用' }).click();
    await expect(picks.first()).toContainText('openai-team');

    await picks.filter({ hasText: 'deepseek-main' }).click();
    await expect(split.getByRole('status')).toContainText('只看账号 deepseek-main');
    // 热力图跟随拆分里选中的账号。
    await expect(page.getByText(/^deepseek-main · /).first()).toBeVisible();
    // 账号不与 Agent、模型交叉：切到 Agent 维度时照常列出全部 Agent 并说明。
    await split.getByRole('group', { name: '拆分维度' }).getByRole('button', { name: 'Agent' }).click();
    await expect(split.getByText(/账号不能与其他维度交叉/)).toBeVisible();
    await split.getByRole('button', { name: '显示全部' }).click();
    await expect(split.getByRole('status')).toHaveCount(0);
  });
});

test.describe('用量明细：按账号筛选', () => {
  test.use({ viewport: { width: 1280, height: 860 } });

  test('热力图只看某账号时点日期，单日明细带上账号筛选，移除标签后不再带', async ({ page, ipc }) => {
    await withAccounts(page, ipc);
    const split = page.locator('section.usage-split');
    await split.scrollIntoViewIfNeeded();
    await split.getByRole('group', { name: '拆分维度' }).getByRole('button', { name: '账号' }).click();
    await split.locator('.usage-split-pick').filter({ hasText: 'deepseek-main' }).click();
    await expect(split.getByRole('status')).toContainText('只看账号 deepseek-main');

    await page.getByRole('button', { name: /2026-07-14.*点击查看当日明细/ }).click();
    const chips = page.getByRole('group', { name: '账号筛选' });
    await expect(chips).toContainText('deepseek-main');
    await expect(chips).toContainText('只含经网关记录的请求');
    const queries = async () => (await ipc.calls('get_usage_details')).map(call => (call.args as { query: { providers?: string[] } }).query);
    await expect.poll(async () => (await queries()).some(query => query.providers?.join() === 'deepseek-main')).toBe(true);

    const before = (await ipc.calls('get_usage_details')).length;
    await chips.getByRole('button', { name: '移除账号筛选：deepseek-main' }).click();
    await expect(chips).toHaveCount(0);
    await expect.poll(async () => (await ipc.calls('get_usage_details')).length).toBeGreaterThan(before);
    const last = (await queries()).at(-1)!;
    expect(last.providers ?? []).toEqual([]);
  });
});

test.describe('请求展开行：Context 构成', () => {
  const context = { systemBytes: 8_000, toolsBytes: 24_000, historyBytes: 40_000, toolResultsBytes: 6_000, attachmentsBytes: 2_000, messages: 38, toolResults: 4, attachments: 1 };

  async function openRecords(page: Page, ipc: IpcFixture) {
    await openPage(page, 'records');
    await expect.poll(async () => (await ipc.calls('get_usage_details')).length).toBeGreaterThan(0);
    const [call] = await ipc.calls('get_usage_details');
    const details = await builtInIpc<UsageDetailsResponse>(page, 'get_usage_details', call.args as Record<string, unknown>);
    const [first, ...rest] = details.items;
    await ipc.override('get_usage_details', { value: { ...details, items: [{ ...first, provider: 'deepseek-main', context }, ...rest] } });
    await reloadSettled(page);
    return first;
  }

  test('网关记下构成的行展开后显示分段横条、估算 Token 与条数', async ({ page, ipc }) => {
    await openRecords(page, ipc);
    await page.getByRole('button', { name: '展开此记录详情' }).first().click();
    const detail = page.locator('.log-detail-context');
    await expect(detail).toContainText('Context 构成 · 估算');
    // 各段按字节占比：历史 40/80 = 50%，工具定义 30%，系统提示 10%。
    await expect(detail.getByRole('img')).toHaveAttribute('aria-label', /50%/);
    await expect(detail.locator('.log-context-legend li')).toHaveCount(5);
    await expect(detail).toContainText('38 条消息 · 4 个工具结果 · 1 个附件');
    await expect(page.locator('.log-detail-row')).toContainText('deepseek-main');
  });

  test('没有构成的行展开后不显示 Context 构成', async ({ page, ipc }) => {
    await openRecords(page, ipc);
    await page.getByRole('button', { name: '展开此记录详情' }).nth(1).click();
    await expect(page.locator('.log-detail-row')).toBeVisible();
    await expect(page.locator('.log-detail-context')).toHaveCount(0);
  });
});
