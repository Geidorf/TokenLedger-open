import type { Page } from '@playwright/test';
import { expect, expectNoHorizontalOverflow, openPage, test } from './fixtures';

// 主要页面：hash 锚点 → 应标为当前页的入口与页内应出现的文案。锚点与 src/hooks/useHashNavigation.ts 一致。
// 一级入口在顶栏「主要页面导航」（顺序：Agent、供应商、网关、路由、用量，设置是右侧齿轮），
// 用量的四个子页在页头「用量子页」分段里。
type Current = { nav: '主要页面导航' | '用量子页' | null; label: string };
const PAGES: { hash: string; current: Current; marker: string }[] = [
  { hash: 'dashboard', current: { nav: '用量子页', label: '概览' }, marker: '有效 Token' },
  { hash: 'records', current: { nav: '用量子页', label: '请求' }, marker: '精确筛选' },
  { hash: 'behavior', current: { nav: '用量子页', label: '会话' }, marker: '会话数' },
  { hash: 'allowances', current: { nav: '用量子页', label: '额度' }, marker: '订阅额度' },
  { hash: 'agents', current: { nav: '主要页面导航', label: 'Agent' }, marker: 'Codex' },
  { hash: 'providers', current: { nav: '主要页面导航', label: '供应商' }, marker: '添加供应商' },
  { hash: 'gateway', current: { nav: '主要页面导航', label: '网关' }, marker: 'http://127.0.0.1:3462/v1' },
  { hash: 'routing', current: { nav: '主要页面导航', label: '路由' }, marker: '新建路由组' },
  { hash: 'settings-scan', current: { nav: null, label: '设置与云端' }, marker: '扫描与启动' },
];

function currentEntry(page: Page, { nav, label }: Current) {
  const scope = nav ? page.getByRole('navigation', { name: nav }) : page.locator('.topbar-actions');
  return scope.getByRole('button', { name: label, exact: true });
}

// 覆盖窄窗、平板、AGENTS.md 要求的 1200/1280 走查宽度与宽屏。
const WIDTHS = [420, 768, 1200, 1280, 1440] as const;

for (const width of WIDTHS) {
  test.describe(`${width}px 宽`, () => {
    test.use({ viewport: { width, height: 860 } });

    for (const { hash, current, marker } of PAGES) {
      test(`#${hash} 正常渲染且无横向滚动`, async ({ page }) => {
        await openPage(page, hash);
        await expect(currentEntry(page, current)).toHaveAttribute('aria-current', 'page');
        await expect(page.locator('main').first().getByText(marker, { exact: false }).first()).toBeAttached();
        await expectNoHorizontalOverflow(page);
      });
    }
  });
}

test('顶栏与用量页头分段在主要页面之间切换', async ({ page }) => {
  await openPage(page, 'dashboard');
  const steps: Current[] = [
    { nav: '用量子页', label: '请求' },
    { nav: '用量子页', label: '会话' },
    { nav: '用量子页', label: '额度' },
    { nav: '主要页面导航', label: '供应商' },
    { nav: null, label: '设置与云端' },
    { nav: '主要页面导航', label: '用量' },
  ];
  for (const step of steps) {
    await currentEntry(page, step).click();
    await expect(currentEntry(page, step)).toHaveAttribute('aria-current', 'page');
  }
  // 从别处回到「用量」落在概览。
  await expect(currentEntry(page, { nav: '用量子页', label: '概览' })).toHaveAttribute('aria-current', 'page');
});
