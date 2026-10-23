import { emit } from '@tauri-apps/api/event';

/**
 * 浏览器 E2E（Playwright）对开发 mock 的接缝。
 *
 * 测试在页面脚本执行前用 addInitScript 写入 `window.__TOKENLEDGER_E2E__`：
 * - `overrides[cmd]` 优先于 devMockTauri 的内置回包；`{ value }` 原样返回，
 *   `{ error }` 让 invoke 以该字符串 reject，用来造空态、错误态与边界数据。
 * - `calls` 由这里追加每次 IPC 调用，测试据此断言前端发出了哪些命令与参数。
 *
 * 只有开发 mock 会调用本模块；生产构建与真实 Tauri 窗口不加载 devMockTauri，
 * 这个全局变量即使存在也不会被读取。
 */
export type E2eIpcOverride = { value: unknown } | { error: string };

export interface E2eIpcCall {
  cmd: string;
  args: unknown;
}

export interface E2eHarness {
  overrides?: Record<string, E2eIpcOverride>;
  calls?: E2eIpcCall[];
  emit?: (event: string, payload?: unknown) => Promise<void>;
}

declare global {
  interface Window {
    __TOKENLEDGER_E2E__?: E2eHarness;
  }
}

function harness(): E2eHarness | undefined {
  return typeof window === 'undefined' ? undefined : window.__TOKENLEDGER_E2E__;
}

/** 装上 mock 时调用：E2E 存在时暴露 emit，让测试模拟后端推送的事件。 */
export function attachE2eHarness() {
  const current = harness();
  if (current) current.emit = (event, payload) => emit(event, payload);
}

/** 记录一次调用；命中覆盖时返回 `{ hit: true, value }`，`error` 覆盖直接抛出。 */
export function resolveE2eOverride(cmd: string, args: unknown): { hit: false } | { hit: true; value: unknown } {
  const current = harness();
  if (!current) return { hit: false };
  (current.calls ??= []).push({ cmd, args });
  const override = current.overrides?.[cmd];
  if (!override) return { hit: false };
  if ('error' in override) throw override.error;
  // 每次回包都给新副本，前端就地修改返回值不会污染后续调用。
  return { hit: true, value: structuredClone(override.value) };
}
