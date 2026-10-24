# 桌面前端浏览器回归（Playwright）

这套用例在真实浏览器里打开桌面前端，是后续信息架构与视觉改版的安全网。它不启动 Tauri，也不读本机数据。

## 怎么跑

```bash
npx playwright install chromium webkit   # 首次运行前装浏览器（Linux 上加 --with-deps 装系统依赖）
npm run test:e2e                         # 全部项目
npx playwright test --project=chromium-zh e2e/ipc.spec.ts   # 只跑一个项目、一个文件
npm run typecheck:e2e                    # 用例类型检查
```

`playwright.config.ts` 会自己在 `127.0.0.1:1430` 起 Vite 开发服务器（与 `npm run dev` 的 1420 错开；可用环境变量 `TOKENLEDGER_E2E_PORT` 改）。本机已有同端口的服务时直接复用。

## 覆盖什么

| 项目 | 浏览器 | 系统语言 |
|---|---|---|
| `chromium-zh` | Chromium（贴近 Windows WebView2） | zh-CN |
| `chromium-en` | Chromium | en-US |
| `webkit-zh` | WebKit（贴近 macOS WKWebView） | zh-CN |
| `webkit-en` | WebKit | en-US |

- `navigation.spec.ts`：用量四个子页（概览、请求、会话、额度）与 Agent、供应商、网关、路由、设置共九个主要页面，在 420、768、1200、1280、1440 宽度下都能渲染且不出现横向滚动；侧栏导航能在页面之间切换。
- `ipc.spec.ts`：用 IPC 夹具覆盖后端回包，验证刷新扫描、取数失败的错误态与重试恢复、后端推送 `stats-updated` 后重新取数。
- `usage.spec.ts`：用量拆分（选中 Agent 后模型列表收窄、热力图标题随之切换、显示全部复原）与请求子页导出 CSV（交给 `export_usage_csv` 的正文带表头）。
- `onboarding.spec.ts`：首次启动引导（自动弹出、扫描后推进、收起到右下角、跳过后不再出现、设置里重新打开）与各页无数据空状态。
- `routing-groups.spec.ts`：路由组成员冷却标记（卡片与右栏、冷却结束后撤掉）、按权重（编辑器占比、卡片显示、只提交非默认权重、420px 不横向滚动）、嵌套子组（其他组可作成员、候选里没有自己、后端拒绝成环时编辑器保持打开）、成员冷却与子组在决策解释链里的说明。
- `usage-accounts.spec.ts`：用量拆分的「账号」维度（无网关记录时禁用并说明、三项指标可选、选中账号后热力图跟随、不与 Agent 交叉）与请求展开行的 Context 构成（有构成才显示）。
- `settings-cards.spec.ts`：「桌面挂件」里的手机动态壁纸开关（保存设置、同步状态、未部署与未登录说明）与「数据与帮助」里的其他电脑共享用量（默认不勾选、只提交选中的电脑、读取失败与清除）。
- `routing-live.spec.ts`：路由页顶部实时路由动画（失败切换逐跳可见、轮询更新、网关未运行空态、外部本机网关）。
- `english.spec.ts`：英文界面（`?lang=en` 或设置里选 English）下的首次启动引导、语言切换与保存、会话/额度/Agent/供应商空状态。
- `visual.spec.ts`：六张截图基线（概览、请求、网关、设置 @1280，概览 @420，英文首次启动引导 @1280），只在 Linux 上的 `chromium-zh` 项目比对。
- `guide-screenshots.spec.ts`：不是回归用例，平时跳过。设环境变量 `TOKENLEDGER_GUIDE_SHOTS=1` 运行时，为用户手册（`docs/guide/`）重新生成桌面配图，见 [docs/guide/README.md](../docs/guide/README.md)。

界面默认中文，English 由用户在设置里选（文案表在 `src/i18n/`，逐页迁移中）。英文项目验证的是英文系统语言下（数字、日期格式和浏览器默认值不同）页面照样正常；英文文案的断言放在 `english.spec.ts`，它在四个项目里都跑。

## 后端怎么模拟

浏览器里没有 Tauri，`src/main.tsx` 会装上 `src/devMockTauri.ts` 的 IPC mock，它的数据固定在 2026-07-15 14:30。夹具（`e2e/fixtures.ts`）在每个用例里另外做了这些事：

- 把浏览器时钟固定在同一时刻、时区固定为 `Asia/Shanghai`，「今日」「更新于」与截图都可重复。
- 中止所有发往开发服务器以外的请求，用例结束时断言没有这类请求，防止页面悄悄依赖外部服务。
- 页面出现未捕获异常或 `console.error` 时让用例失败。

地址带 `?fresh=1` 时 mock 扮演一台刚装好的电脑：本机账本、云端账户、模型接入与网关供应商都是空的，第一次「扫描本机日志」后示例账本才出现；`?fresh=gateway` 相同，只是模型接入已打开。用它看首次启动引导与空状态。

单个用例需要不同的后端数据时，用 `ipc` 夹具；只想在内置回包上补几个字段时，先用 `builtInIpc(page, cmd, args)` 取到内置回包再 `override`（统计类回包的 `meta` 要与当前筛选一致，所以 `args` 取自 `ipc.calls(cmd)` 里前端实际发出的那次）：

```ts
test('取数失败', async ({ page, ipc }) => {
  await ipc.override('get_cached_stats', { error: '本机数据库被占用' }); // 让 invoke reject
  await ipc.override('get_settings', { value: { ...settings } });        // 换一份回包
  await page.goto('/#dashboard');
  await ipc.restore('get_cached_stats');                                 // 回到内置 mock
  expect(await ipc.calls('refresh_scan')).toHaveLength(0);              // 读回前端发出的调用
  await ipc.emit('stats-updated');                                       // 模拟后端推送事件
});
```

`override` 在 `page.goto` 之前调用对首次加载生效，页面打开后调用会立刻改当前页。接缝本身在 `src/devMockE2e.ts`：它只被开发 mock 引用，生产构建不包含。

## 截图基线

基线放在 `e2e/__screenshots__/` 并入库（与 Android 的截图回归参考图一样，属于测试输入，不是验收证据）。字体光栅化随系统变化，所以只在 Linux Chromium 上生成和比对，生成环境是 Ubuntu 24.04 并装了 `fonts-inter`、`fonts-jetbrains-mono`、`fonts-dejavu-*`、`fonts-liberation`、`fonts-noto-color-emoji`、`fonts-wqy-zenhei`（CI 的 desktop-e2e job 装同一套；本机重生成基线前先装齐，否则整页文字会变）；`@playwright/test` 钉在精确版本，浏览器构建跟着固定。

有意改变画面时：

```bash
npm run test:e2e:update   # 在 Linux 上运行；只重写 chromium-zh 项目的基线
```

在 PR 里说明哪些画面有意改变。不是 Linux 的机器可以把这一步交给云端工位，或从 CI 失败时上传的 `playwright-report` 里取实际截图核对。升级 `@playwright/test` 时同时重新生成基线。

## 失败时看什么

CI 失败会上传 `playwright-report`（HTML 报告）和 `test-results`（失败截图、trace）。本机用 `npx playwright show-report` 或 `npx playwright show-trace <trace.zip>` 打开。
