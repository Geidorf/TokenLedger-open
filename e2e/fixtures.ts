import { test as base, expect, type Page } from '@playwright/test';
// 引入类型同时带入 window.__TOKENLEDGER_E2E__ 的全局声明。
import type { E2eIpcCall, E2eIpcOverride } from '../src/devMockE2e';

/**
 * 所有 E2E 用例共用的夹具。
 *
 * - 时钟固定在 devMockTauri 的 mockNow（2026-07-15 14:30，Asia/Shanghai），
 *   「今日 / 更新于」等文案与截图因此可重复。
 * - 网络封闭：除 Vite 开发服务器外的请求一律中止并记下，用例结束时断言为空，
 *   防止页面悄悄依赖外部服务。
 * - 页面未捕获异常与 console.error 让用例失败。
 * - `ipc` 夹具在页面脚本运行前写入 window.__TOKENLEDGER_E2E__，按命令覆盖
 *   mock 回包或制造错误，并读回前端实际发出的 IPC 调用（见 src/devMockE2e.ts）。
 */
export const MOCK_NOW = '2026-07-15T14:30:00+08:00';

export type IpcOverride = E2eIpcOverride;
export type IpcCall = E2eIpcCall;

export interface IpcFixture {
  /** 在 page.goto 之前调用对首次加载生效；页面已打开时也会立即改当前页。 */
  override(cmd: string, override: IpcOverride): Promise<void>;
  /** 去掉某命令的覆盖，回到 devMockTauri 的内置回包。 */
  restore(cmd: string): Promise<void>;
  /** 读回到目前为止的 IPC 调用，可按命令过滤。 */
  calls(cmd?: string): Promise<IpcCall[]>;
  /** 模拟后端推送事件，例如 `stats-updated`。 */
  emit(event: string, payload?: unknown): Promise<void>;
}

// 已知、与用例无关的控制台噪声。新增条目必须写明来源。
const IGNORED_CONSOLE_ERRORS: RegExp[] = [];

export const test = base.extend<{ ipc: IpcFixture; guard: void }>({
  ipc: async ({ page }, use) => {
    await use({
      async override(cmd, override) {
        const install = ([name, value]: readonly [string, IpcOverride]) => {
          const harness = (window.__TOKENLEDGER_E2E__ ??= {});
          (harness.overrides ??= {})[name] = value;
        };
        // 之后每次加载都生效；init script 按注册顺序执行，后写的覆盖先写的。
        await page.addInitScript(install, [cmd, override] as const);
        // 页面已打开时同步改当前页，用来模拟「重试后恢复」之类的状态切换。
        if (page.url() !== 'about:blank') await page.evaluate(install, [cmd, override] as const);
      },
      async restore(cmd) {
        const remove = (name: string) => { delete window.__TOKENLEDGER_E2E__?.overrides?.[name]; };
        await page.addInitScript(remove, cmd);
        if (page.url() !== 'about:blank') await page.evaluate(remove, cmd);
      },
      async calls(cmd) {
        const all = await page.evaluate(() => window.__TOKENLEDGER_E2E__?.calls ?? []);
        return cmd ? all.filter(call => call.cmd === cmd) : all;
      },
      async emit(event, payload) {
        await page.evaluate(([name, data]) => window.__TOKENLEDGER_E2E__?.emit?.(name as string, data), [event, payload] as const);
      },
    });
  },

  guard: [async ({ page, baseURL }, use) => {
    const origin = new URL(baseURL!).origin;
    const blocked: string[] = [];
    const errors: string[] = [];

    await page.clock.setFixedTime(new Date(MOCK_NOW));
    await page.addInitScript(() => {
      window.__TOKENLEDGER_E2E__ ??= {};
    });
    await page.route('**/*', route => {
      const url = route.request().url();
      if (url.startsWith(origin) || url.startsWith('data:') || url.startsWith('blob:')) return route.continue();
      blocked.push(url);
      return route.abort('blockedbyclient');
    });
    page.on('pageerror', error => errors.push(`pageerror: ${error.message}`));
    page.on('console', message => {
      if (message.type() !== 'error') return;
      const text = message.text();
      if (IGNORED_CONSOLE_ERRORS.some(pattern => pattern.test(text))) return;
      errors.push(`console.error: ${text}`);
    });

    await use();

    expect(blocked, '页面不应请求开发服务器以外的地址').toEqual([]);
    expect(errors, '页面不应有未捕获异常或 console.error').toEqual([]);
  }, { auto: true }],
});

export { expect };

/** 打开某个 hash 页面并等主区域渲染完成。 */
export async function openPage(page: Page, hash: string) {
  await page.goto(`/#${hash}`);
  await expect(page.locator('main').first()).toBeVisible();
}

/** 断言页面在当前视口宽度下没有横向滚动。 */
export async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, '页面不应出现横向滚动').toBeLessThanOrEqual(1);
}
