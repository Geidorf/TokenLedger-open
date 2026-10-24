import { builtInIpc, expect, expectNoHorizontalOverflow, openPage, reloadSettled, test } from './fixtures';

// 概览卡片布局：编辑模式里拖动与键盘排序、调宽、隐藏，多套布局切换并在重开后保留。
const cardOrder = (page: import('@playwright/test').Page) =>
  page.locator('[data-layout-card]').evaluateAll(cards => cards.map(card => (card as HTMLElement).dataset.layoutCard));

test.describe('概览卡片布局', () => {
  test('键盘拿起卡片移动，调宽与隐藏，重开后保留', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await openPage(page, 'dashboard');
    await page.getByRole('button', { name: '编辑布局' }).click();
    await expect(page.getByRole('region', { name: '编辑概览布局' })).toBeVisible();

    const trend = page.getByRole('button', { name: /^移动卡片：趋势/ });
    await trend.focus();
    await page.keyboard.press('Space');
    await expect(trend).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Home');
    await page.keyboard.press('Space');
    await expect(page.getByRole('button', { name: /^移动卡片：趋势/ })).toBeFocused();
    expect((await cardOrder(page))[0]).toBe('trend');

    await page.getByRole('group', { name: '趋势宽度' }).getByRole('button', { name: '半宽' }).click();
    await expect(page.locator('[data-layout-card="trend"]')).toHaveAttribute('data-width', 'half');
    await page.getByRole('button', { name: '隐藏卡片：Agent 用量' }).click();
    await page.getByRole('button', { name: '完成', exact: true }).click();
    await expect(page.locator('[data-layout-card="tools"]')).toHaveCount(0);

    await reloadSettled(page);
    // 重开后卡片可能晚于页面就绪才渲染，轮询读顺序。
    await expect.poll(async () => (await cardOrder(page))[0]).toBe('trend');
    await expect(page.locator('[data-layout-card="trend"]')).toHaveAttribute('data-width', 'half');
    await expect(page.locator('[data-layout-card="tools"]')).toHaveCount(0);
  });

  test('鼠标拖动手柄排序', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await openPage(page, 'dashboard');
    await page.getByRole('button', { name: '编辑布局' }).click();
    const metrics = page.getByRole('button', { name: /^移动卡片：统计条/ });
    const target = page.locator('[data-layout-card="trend"]');
    const from = (await metrics.boundingBox())!;
    const to = (await target.boundingBox())!;
    await page.mouse.move(from.x + 20, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x + 40, to.y + to.height * 0.8, { steps: 8 });
    await page.mouse.up();
    const order = await cardOrder(page);
    expect(order.indexOf('metrics')).toBeGreaterThan(order.indexOf('trend'));
  });

  test('一键切换「省钱」布局、另存新布局、恢复默认', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await openPage(page, 'dashboard');
    await builtInIpc(page, 'set_budget_settings', { settings: { notify: true, rules: [
      { id: 'b1', enabled: true, period: 'month', metric: 'cost', scopeKind: 'all', scopeId: '', limit: 50, warnPercent: 80 },
    ] } });
    const layouts = page.getByRole('radiogroup', { name: '概览布局' });
    await layouts.getByRole('radio', { name: '省钱' }).click();
    await expect(layouts.getByRole('radio', { name: '省钱' })).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByRole('region', { name: '预算' })).toBeVisible();
    await expect(page.getByRole('meter', { name: /本月 · 全部用量 · 预估费用已用比例/ })).toBeVisible();
    await expect(page.locator('[data-layout-card="heatmap"]')).toHaveCount(0);

    await page.getByRole('button', { name: '编辑布局' }).click();
    await page.getByRole('button', { name: '另存为新布局' }).click();
    await expect(layouts.getByRole('radio', { name: '省钱 副本' })).toHaveAttribute('aria-checked', 'true');
    await page.getByLabel('布局名称').fill('周会');
    await page.getByLabel('布局名称').press('Enter');
    await expect(layouts.getByRole('radio', { name: '周会' })).toBeVisible();
    await page.getByRole('button', { name: '删除布局' }).click();
    await page.getByRole('button', { name: '确认删除' }).click();
    await expect(layouts.getByRole('radio')).toHaveCount(2);

    // 方向键在布局间切换。
    await layouts.getByRole('radio', { name: '省钱' }).focus();
    await page.keyboard.press('ArrowLeft');
    await expect(layouts.getByRole('radio', { name: '日常' })).toHaveAttribute('aria-checked', 'true');
    await page.getByRole('button', { name: /^隐藏卡片：趋势/ }).click();
    await page.getByRole('button', { name: '恢复默认' }).click();
    await expect(page.getByRole('button', { name: /^隐藏卡片：趋势/ })).toBeVisible();
  });

  test('窄窗口下半宽卡片退回全宽，不出现横向滚动', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 860 });
    await openPage(page, 'dashboard');
    await page.getByRole('radiogroup', { name: '概览布局' }).getByRole('radio', { name: '省钱' }).click();
    const budget = page.locator('[data-layout-card="budget"]');
    const grid = page.locator('.dashboard-layout-grid');
    await expect(budget).toBeVisible();
    const [cardBox, gridBox] = [await budget.boundingBox(), await grid.boundingBox()];
    expect(Math.round(cardBox!.width)).toBe(Math.round(gridBox!.width));
    await expectNoHorizontalOverflow(page);
  });

  test('窄窗口下按上下半边决定落点', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 2400 });
    await openPage(page, 'dashboard');
    await page.getByRole('radiogroup', { name: '概览布局' }).getByRole('radio', { name: '省钱' }).click();
    await page.getByRole('button', { name: '编辑布局' }).click();
    const handle = page.getByRole('button', { name: /^移动卡片：统计条/ });
    const target = (await page.locator('[data-layout-card="budget"]').boundingBox())!;
    const from = (await handle.boundingBox())!;
    // 半宽卡片在窄窗口里独占一行：沿左侧竖直拖到它的下半部，应排到它后面。
    await page.mouse.move(from.x + 10, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(target.x + 10, target.y + target.height * 0.85, { steps: 8 });
    await page.mouse.up();
    const order = await cardOrder(page);
    expect(order.indexOf('metrics')).toBe(order.indexOf('budget') + 1);
  });

  test('拖到别的卡片再拖回原处松手，顺序不变', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await openPage(page, 'dashboard');
    await page.getByRole('button', { name: '编辑布局' }).click();
    const before = await cardOrder(page);
    const handle = page.getByRole('button', { name: /^移动卡片：统计条/ });
    const from = (await handle.boundingBox())!;
    const other = (await page.locator('[data-layout-card="trend"]').boundingBox())!;
    await page.mouse.move(from.x + 20, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(other.x + 40, other.y + other.height * 0.8, { steps: 6 });
    await expect(page.locator('[data-layout-card="trend"]')).toHaveAttribute('data-drop', 'after');
    await page.mouse.move(from.x + 20, from.y + from.height / 2, { steps: 6 });
    await expect(page.locator('[data-drop]')).toHaveCount(0);
    await page.mouse.up();
    expect(await cardOrder(page)).toEqual(before);
  });
});
