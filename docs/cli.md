# 命令行工具 tokenledger-cli

`tokenledger-cli` 在终端里查看 TokenLedger 记下的用量、额度、预算与本机网关，也能触发扫描和导出账本。它和桌面端是同一个 Rust 核心库编出来的另一个可执行文件，读同一个数据目录，所有数字都走桌面端同一套计算：

| 命令 | 数字从哪来 |
|---|---|
| `usage` | 本机看板统计（Stats v2，与看板、托盘、预算同口径，见 [dashboard-stats-v2](contracts/dashboard-stats-v2.md)） |
| `quota` | 本机额度来源，与看板冷启动同一路径（见 [quota-provider-v1](contracts/quota-provider-v1.md)） |
| `budget` | 预算页的同一次评估 |
| `gateway` | 本机网关的配置文件与用量账本 |
| `scan` | 桌面端同一个扫描器 |
| `export` | 设置页「导出 CSV」的同一组列与逐行估价 |

它不读任何订阅凭据，不调用未公开接口。额度只查询你在桌面端「设置 · 订阅额度」里已经授权的来源，没授权的显示「未授权」。扫描只入本机账本，不往云端推，新记录由桌面端下一轮同步带上。

## 构建与安装

桌面安装包已经带上它：Tauri 打包时会把 crate 里的所有可执行文件一起装进去，不用另外配置。装好后位置如下（不会自动加进 `PATH`，需要时自己加或建链接）：

| 安装包 | 位置 |
|---|---|
| Linux deb | `/usr/bin/tokenledger-cli`（已在 `PATH`） |
| Windows NSIS / MSI | 安装目录里与 `tokenledger.exe` 同级的 `tokenledger-cli.exe` |
| macOS DMG | `TokenLedger.app/Contents/MacOS/tokenledger-cli`，可 `ln -s` 到 `/usr/local/bin` |

Linux deb 已在本地打包核对过；Windows 与 macOS 按同一套打包规则，待验收工位装机确认。

单独构建：

```sh
# 在仓库根目录
mkdir -p dist   # 编译期校验 frontendDist，空目录即可
cargo build --release --manifest-path src-tauri/Cargo.toml --bin tokenledger-cli
# 产物：src-tauri/target/release/tokenledger-cli（Windows 为 tokenledger-cli.exe）
```

把它放进 `PATH` 即可，例如 `~/.local/bin`。名字太长可以自己起别名：`alias tl=tokenledger-cli`。

Linux 编译需要和桌面端相同的系统库（`libwebkit2gtk-4.1-dev`、`libgtk-3-dev` 等），因为它链接同一个核心库。

## 用法

```text
tokenledger-cli <命令> [选项] [--json]
```

| 命令 | 说明 |
|---|---|
| `usage [范围] [--by agent\|model\|account] [--agent 名] [--model 名]` | 用量合计，默认今日；`--by` 拆分，`--agent`/`--model` 可重复用来筛选 |
| `quota` | 各额度来源的窗口、剩余与重置时间 |
| `budget` | 启用中的预算：已用、上限、比例与状态 |
| `gateway [--limit N]` | 网关是否在运行、供应商与路由组数量、最近 N 条（默认 10，最多 500）经网关的请求与实际路由 |
| `scan` | 立即扫描本机各 Agent 的日志入库 |
| `export [范围] [--format csv\|json] [--output 文件]` | 导出账本，默认整本、CSV、写到标准输出 |
| `status [--no-quota]` | 一行摘要，给状态栏插件用 |
| `mcp` | 以 stdio 运行只读 MCP 服务，给 Claude Code、Codex 等 Agent 调用，见 [MCP 文档](mcp.md) |
| `help`、`version` | 帮助与版本 |

范围：`today`、`week`、`month`、`year`、`all`，或 `--from YYYY-MM-DD --to YYYY-MM-DD`（本地日期闭区间）。周从周一开始，与看板一致。

数据目录与桌面端相同；环境变量 `TOKENLEDGER_APPDATA` 可指向别的目录（例如测试数据）。

退出码：`0` 成功，`1` 执行失败（`--json` 时标准输出另有 `{"schemaVersion":1,"error":"…"}`），`2` 参数错误。

### 例子

```sh
tokenledger-cli usage week --by agent
tokenledger-cli usage month --by model --json | jq '.breakdown.rows[0]'
tokenledger-cli export --from 2026-10-01 --to 2026-10-31 --format csv --output october.csv
tokenledger-cli status            # 今日 1.23M · $4.56 | 预算 82% | Codex 5h 余 37%
```

### 状态栏插件

`status` 输出一行：今日 Token 与预估费用；有启用的预算时加上比例最高的一项；有可用额度时加上剩余百分比最低的窗口。读额度要查各来源，比较慢，刷新频繁时可以加 `--no-quota`。需要自己排版时用 `status --json`。

## 与桌面端同时运行

- 读取类命令只读数据目录，桌面端开着也可以随便跑。
- `scan` 与桌面端的后台扫描可能同时进行。写入走同一个 SQLite 文件的事务，记录按唯一键去重，所以不会重复计数（`src-tauri/tests/cli_concurrent_scan.rs` 用多个真实进程同时扫描验证）；桌面端界面在它下一次刷新时显示新记录。桌面端与命令行的扫描还共用一把跨进程文件锁（数据目录里的 `tokenboard.scan.lock`），同一时刻只有一个进程在读源和落库，流式更新中的记录不会被另一个进程读到的旧快照覆盖。还没有账本时（桌面端从没启动过）两个进程同时首次建库，其中一个可能报 `database is locked`，重跑即可。
- `gateway` 判断「运行中」只请求本机网关的 `/health`（不需要 token）。路由决策的详细过程只存在桌面端进程内存里，命令行看到的是账本里每条请求最终走到的 `供应商/模型`。

## JSON 字段（schemaVersion 1）

所有 `--json` 输出都是一个对象（`export` 写标准输出时除外，见下），带 `schemaVersion` 与 `command`。只做向后兼容的新增，改名或删字段会升 `schemaVersion`。

**数字缺失的约定**：价格不可得的费用、来源无法证明的读写缓存拆分、不可用的账号维度都输出 `null` 或不输出，不会补 0，与看板契约一致。

### usage

```json
{
  "schemaVersion": 1, "command": "usage",
  "range": "week", "timezone": "Asia/Shanghai", "generatedAt": "2026-10-24T12:00:00+08:00",
  "start": "2026-10-01", "end": "2026-10-07",
  "filters": { "agents": ["codex"], "models": [] },
  "summary": {
    "totalTokens": 0, "inputTokens": 0, "outputTokens": 0, "cachedTokens": 0,
    "cacheReadTokens": 0, "cacheWriteTokens": 0,
    "totalCost": 0.0, "totalRequests": 0
  },
  "breakdown": {
    "by": "agent", "available": true,
    "rows": [{ "id": "codex", "name": "Codex", "totalTokens": 0, "inputTokens": 0, "outputTokens": 0, "cachedTokens": 0, "cost": 0.0, "requests": 0 }]
  }
}
```

- `start`/`end` 只在 `--from/--to` 时出现；`filters` 只在筛选时出现；`breakdown` 只在 `--by` 时出现。
- `totalTokens` 是有效 Token（输入 + 输出），缓存单列。
- `breakdown.rows` 按 `totalTokens` 从大到小。`by: "account"` 时账号来自本机网关账本，没有网关记录时 `available: false`、`rows: []`；扫描记录没有账号，所以各账号合计可以小于 `summary`。

### quota

`{ "schemaVersion": 1, "command": "quota", "providers": [ … ] }`，`providers` 每项就是额度契约里的 envelope（`providerId`、`displayName`、`status`、`windows[]` 等），原样输出。

### budget

`{ "schemaVersion": 1, "command": "budget", "generatedAt": "…", "statuses": [ … ] }`。每项：`ruleId`、`periodStart`、`used`、`limit`、`percent`、`level`（`ok` / `warn` / `over` / `unavailable`），以及规则本身的 `period`、`metric`、`scopeKind`、`scopeId`、`warnPercent`。

### gateway

```json
{
  "schemaVersion": 1, "command": "gateway",
  "modelAccessEnabled": true, "running": true, "port": 3462, "baseUrl": "http://127.0.0.1:3462/v1",
  "providerCount": 2, "enabledProviderCount": 2, "routingGroupCount": 1, "configError": null,
  "recent": [{
    "ts": "…", "agent": "codex", "provider": "…", "model": "group/fast", "upstreamModel": "…",
    "group": "fast", "member": "provider/model", "status": 200, "ok": true, "latencyMs": 812,
    "inputTokens": 0, "outputTokens": 0, "cacheReadTokens": 0, "cacheWriteTokens": 0
  }]
}
```

`recent` 从新到旧，不含会话 ID、错误正文与上游地址。

### scan

`{ "schemaVersion": 1, "command": "scan", "inserted": 12, "message": "…", "codexRebuildDeferred": false, "discoveredPriceModels": [] }`

### export

不带 `--output` 时，标准输出就是导出内容本身：CSV 带表头；JSON 是数组，每项的键与 CSV 表头相同（`id`、`tool`、`model`、`input_tokens`、`output_tokens`、`cached_tokens`、`cache_write_tokens`、`timestamp`、`session_id`、`unique_key`、`cost_usd`、`estimated_cost_usd`、`machine_id`、`sync_status`、`cloud_user_id`、`synced_at`），费用不可得为 `null`。CSV 对以 `=`、`+`、`-`、`@` 开头的单元格加 `'` 防公式注入，JSON 保留原值。

带 `--output` 时写文件，标准输出是 `{ "schemaVersion": 1, "command": "export", "path": "…", "records": 3 }`（`--json`）或一行提示。

### status

`{ "schemaVersion": 1, "command": "status", "text": "今日 … | 预算 … | …", "today": { 同 usage.summary }, "budget": { 同 budget.statuses 的一项 } | null, "quota": { "provider", "window", "remainingPercent", "resetsAt" } | null }`
