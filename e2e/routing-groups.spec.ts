import type { Locator, Page } from '@playwright/test';
import { expect, expectNoHorizontalOverflow, MOCK_NOW, openPage, test } from './fixtures';

// 路由组今晚新增的三项：按权重分配、嵌套子组、成员失败冷却。
// 编辑器的增改走真实浏览器；冷却与子组展开只在网关的决策解释链里体现，用覆盖的决策数据验证。

async function newGroupDialog(page: Page, name: string, id: string) {
  await openPage(page, 'routing');
  await page.getByRole('button', { name: /新建路由组/ }).click();
  const dialog = page.getByRole('dialog', { name: '新建路由组' });
  await dialog.getByLabel('名称').fill(name);
  await dialog.getByLabel(/^ID/).fill(id);
  return dialog;
}

async function addMember(dialog: Locator, member: string) {
  await dialog.getByLabel('选择成员').selectOption(member);
  await dialog.getByRole('button', { name: /添加成员/ }).click();
}

function groupCard(page: Page, name: string) {
  return page.locator('.mw-group').filter({ has: page.getByText(name, { exact: true }) });
}

test.describe('路由组', () => {
  test.use({ viewport: { width: 1280, height: 860 } });

  test('按权重：编辑器实时显示占比，保存后卡片显示权重与占比，只提交非默认权重', async ({ page, ipc }) => {
    const dialog = await newGroupDialog(page, '分流', 'split');
    await addMember(dialog, 'openai/gpt-5');
    await addMember(dialog, 'deepseek/deepseek-chat');
    await addMember(dialog, 'deepseek/deepseek-reasoner');
    await dialog.getByLabel(/^分配方式/).selectOption('weighted');
    await dialog.getByLabel('openai/gpt-5 的权重').fill('2');
    await dialog.getByLabel('deepseek/deepseek-chat 的权重').fill('1');
    await dialog.getByLabel('deepseek/deepseek-reasoner 的权重').fill('1');
    await expect(dialog.locator('.mw-weight').first()).toContainText('50%');
    // 超出范围的权重收回到上限。
    await dialog.getByLabel('deepseek/deepseek-reasoner 的权重').fill('500');
    await expect(dialog.getByLabel('deepseek/deepseek-reasoner 的权重')).toHaveValue('100');
    await dialog.getByLabel('deepseek/deepseek-reasoner 的权重').fill('1');
    await dialog.getByRole('button', { name: '保存' }).click();
    await expect(dialog).toHaveCount(0);

    const card = groupCard(page, '分流');
    await expect(card.getByText('按权重', { exact: false }).first()).toBeVisible();
    await expect(card.locator('.mw-members li')).toHaveText([/权重 2 · 50%/, /权重 1 · 25%/, /权重 1 · 25%/]);
    const [call] = await ipc.calls('gateway_upsert_routing_group');
    expect((call.args as { group: unknown }).group).toMatchObject({ id: 'split', strategy: 'weighted', weights: { 'openai/gpt-5': 2 } });
    expect((call.args as { group: { weights: Record<string, number> } }).group.weights).not.toHaveProperty('deepseek/deepseek-chat');
  });

  test('嵌套：其他路由组可作成员，编辑时候选里没有自己', async ({ page, ipc }) => {
    const dialog = await newGroupDialog(page, '总入口', 'entry');
    await addMember(dialog, 'group/coding');
    await addMember(dialog, 'deepseek/deepseek-chat');
    await dialog.getByRole('button', { name: '保存' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(groupCard(page, '总入口').locator('.mw-members li')).toHaveText([/group\/coding/, /deepseek\/deepseek-chat/]);
    const [call] = await ipc.calls('gateway_upsert_routing_group');
    expect((call.args as { group: unknown }).group).toMatchObject({ id: 'entry', members: ['group/coding', 'deepseek/deepseek-chat'] });

    await page.getByRole('button', { name: '编辑 总入口' }).click();
    const edit = page.getByRole('dialog', { name: '总入口' });
    const choices = await edit.getByLabel('选择成员').locator('option').evaluateAll(options => options.map(option => (option as HTMLOptionElement).value));
    expect(choices).toContain('group/cheap');
    expect(choices).not.toContain('group/entry');
  });

  test('后端拒绝成环的嵌套时给出错误，编辑器保持打开', async ({ page, ipc }) => {
    await ipc.override('gateway_upsert_routing_group', { error: '路由组 group/coding 与 group/loop 互相包含，不能成环。' });
    const dialog = await newGroupDialog(page, '环', 'loop');
    await addMember(dialog, 'group/coding');
    await dialog.getByRole('button', { name: '保存' }).click();
    await expect(page.getByText('路由组 group/coding 与 group/loop 互相包含，不能成环。')).toBeVisible();
    await expect(dialog).toBeVisible();
  });

  test('冷却中的成员：卡片与右栏都标出剩余时间，冷却结束后轮询把标记撤掉', async ({ page, ipc }) => {
    await ipc.override('gateway_routing_cooldowns', { value: [
      { member: 'openai/gpt-5', remainingSecs: 45, failures: 1 },
      { member: 'deepseek/deepseek-reasoner', remainingSecs: 150, failures: 3 },
    ] });
    await openPage(page, 'routing');
    const coding = groupCard(page, '编码主力');
    const gpt = coding.locator('.mw-members li').filter({ hasText: 'openai/gpt-5' });
    await expect(gpt.getByText('冷却中 · 约 45 秒')).toBeVisible();
    await expect(gpt.getByText('冷却中 · 约 45 秒')).toHaveAttribute('title', /连续失败 1 次/);
    await expect(coding.locator('.mw-members li').filter({ hasText: 'deepseek/deepseek-chat' }).locator('.is-warning')).toHaveCount(0);
    await expect(groupCard(page, '便宜优先').getByText('冷却中 · 约 3 分钟')).toBeVisible();
    const aside = page.getByRole('region', { name: '冷却中的成员' });
    await expect(aside.getByRole('listitem')).toHaveCount(2);

    // 有冷却时每 10 秒轮询一次；冷却结束后标记与右栏一起消失。
    await ipc.override('gateway_routing_cooldowns', { value: [] });
    await page.clock.runFor(10_000).catch(() => undefined);
    await expect(aside).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByText(/冷却中 · 约/)).toHaveCount(0);
  });

  test('冷却与子组：决策解释链写明首选冷却中后移、候选来自哪个子组', async ({ page, ipc }) => {
    const ts = new Date(Date.parse(MOCK_NOW) - 60_000).toISOString();
    await ipc.override('gateway_recent_route_decisions', { value: [{
      ts, requestId: 'n1', group: 'entry', session: null, reason: 'failover',
      detail: '按顺序；openai/gpt-5 冷却中，已后移',
      chosen: 'deepseek/deepseek-chat',
      attempts: [{ member: 'deepseek/deepseek-chat', outcome: 'ok', status: 200 }],
      trace: [
        { member: 'deepseek/deepseek-chat', rank: 0, verdict: 'chosen', reasons: ['strategy_first', 'nested', 'answered'], detail: null },
        { member: 'openai/gpt-5', rank: 1, verdict: 'not_reached', reasons: ['fallback', 'cooling_down', 'not_reached'], detail: '冷却中' },
      ],
    }] });
    await openPage(page, 'routing');
    const panel = page.getByRole('complementary', { name: '最近路由决策' });
    await expect(panel).toContainText('openai/gpt-5 冷却中，已后移');
    await panel.getByText('为什么这样选（2 个成员）').click();
    const rows = panel.getByRole('list', { name: 'group/entry 成员决策' }).getByRole('listitem');
    await expect(rows.nth(0)).toContainText('策略首选 · 来自子组 · 已响应');
    await expect(rows.nth(1)).toContainText('备选 · 冷却中 · 前一个已响应');
  });
});

test('420px 窄窗：按权重的编辑器与卡片不出现横向滚动', async ({ page }) => {
  await page.setViewportSize({ width: 420, height: 860 });
  const dialog = await newGroupDialog(page, '窄窗分流', 'narrow');
  await addMember(dialog, 'openrouter/anthropic/claude-sonnet-4.5');
  await addMember(dialog, 'deepseek/deepseek-reasoner');
  await dialog.getByLabel(/^分配方式/).selectOption('weighted');
  await expect(dialog.getByLabel('openrouter/anthropic/claude-sonnet-4.5 的权重')).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await dialog.getByRole('button', { name: '保存' }).click();
  await expect(groupCard(page, '窄窗分流').locator('.mw-members li').first()).toContainText('权重 1 · 50%');
  await expectNoHorizontalOverflow(page);
});
