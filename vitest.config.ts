import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    // 默认的 forks 池在 Windows 上会间歇性建不起 worker IPC（本机实测过一次
    // 21 个 worker 全部 `Timeout waiting for worker to respond`，122 秒后报
    // "no tests" 并以 0 退出的假绿）。这套用例是纯 jsdom + React，threads 池
    // 语义等价、耗时更短，且不会出现那种「没跑任何测试却像通过了」的状态。
    pool: 'threads',
    // Vitest 默认 5000ms。2026-08-23 的 T10.76 门禁跑里，
    // `LogsTable > Session ID 复制成功与失败都提供可确认的状态` 在本机同时编译
    // Rust 时超时报红，单独重跑与空载全量重跑都是 6/6、123/123 通过——也就是
    // 一次纯粹由机器负载造成的假红。jsdom + React 19 的 environment 建立本身
    // 就要几百毫秒，5 秒对这类交互用例太紧。放宽到 15 秒不会掩盖真实死锁
    // （真卡住仍会超时），但能让门禁结果只反映代码。
    testTimeout: 15_000,
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    css: false,
  },
});
