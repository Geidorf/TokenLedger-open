import { expect, expectNoHorizontalOverflow, openPage, test } from './fixtures';

// 主要页面：hash 锚点 → 页面标题区应出现的文案。锚点与 src/hooks/useHashNavigation.ts 一致。
const PAGES = [
  { hash: 'dashboard', heading: '用量 · 概览', marker: '有效 Token' },
  { hash: 'records', heading: '用量 · 请求', marker: '精确筛选' },
  { hash: 'behavior', heading: '用量 · 会话', marker: '会话数' },
  { hash: 'allowances', heading: '用量 · 额度', marker: '订阅额度' },
  { hash: 'agents', heading: '模型接入', marker: 'Codex' },
  { hash: 'providers', heading: '模型接入', marker: '添加供应商' },
  { hash: 'gateway', heading: '模型接入', marker: 'http://127.0.0.1:3462/v1' },
  { hash: 'routing', heading: '模型接入', marker: '新建路由组' },
  { hash: 'settings-scan', heading: '设置与云端', marker: '扫描与启动' },
] as const;

// 覆盖窄窗、平板、AGENTS.md 要求的 1200/1280 走查宽度与宽屏。
const WIDTHS = [420, 768, 1200, 1280, 1440] as const;

for (const width of WIDTHS) {
  test.describe(`${width}px 宽`, () => {
    test.use({ viewport: { width, height: 860 } });

    for (const { hash, heading, marker } of PAGES) {
      test(`#${hash} 正常渲染且无横向滚动`, async ({ page }) => {
        await openPage(page, hash);
        const main = page.locator('main').first();
        await expect(main.getByText(heading, { exact: false }).first()).toBeVisible();
        await expect(main.getByText(marker, { exact: false }).first()).toBeAttached();
        await expectNoHorizontalOverflow(page);
      });
    }
  });
}

test('侧栏导航在主要页面之间切换', async ({ page }) => {
  await openPage(page, 'dashboard');
  const nav = page.getByRole('navigation', { name: '主要页面导航' });
  const steps = [
    { label: '请求', heading: '用量 · 请求' },
    { label: '会话', heading: '用量 · 会话' },
    { label: '额度', heading: '用量 · 额度' },
    { label: '供应商', heading: '模型接入' },
    { label: '设置与云端', heading: '设置与云端' },
    { label: '概览', heading: '用量 · 概览' },
  ];
  for (const { label, heading } of steps) {
    await nav.getByRole('button', { name: label, exact: true }).click();
    await expect(page.locator('main').first().getByText(heading).first()).toBeVisible();
  }
});
