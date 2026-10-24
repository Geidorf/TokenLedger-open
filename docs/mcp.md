# 本机 MCP 服务

`tokenledger-cli mcp` 把 TokenLedger 记下的用量开放给 Claude Code、Codex 等支持 [MCP](https://modelcontextprotocol.io) 的 Agent：Agent 可以自己查今天花了多少、额度还剩多少、预算是否快超了，在额度紧张时主动节制。

它是 [命令行工具](cli.md) 的一个子命令，同一个可执行文件、同一个数据目录、同一套计算，数字和桌面看板、`tokenledger-cli --json` 一致，不另算口径。

## 安全边界

- **只走标准输入输出**：由 Agent 以子进程方式启动，一行一条 JSON-RPC 消息，不监听任何端口；退出 Agent 服务就结束。
- **只读**：不扫描、不写账本、不改设置、不往云端推。数据由桌面端后台扫描（或手动 `tokenledger-cli scan`）更新，所以看到的是最近一次扫描的结果。
- **不暴露敏感内容**：不输出密钥、订阅凭据、请求或回复正文、会话 ID、上游地址，也不输出额度来源的账号标签。网关最近请求只给路由结果（供应商、模型、状态码、耗时、Token 数）。
- **额度只查已授权的来源**：和桌面端一样，只查询你在「设置 · 订阅额度」里授权过的来源，不读任何订阅凭据，不调用未公开接口。网关探活只连 `127.0.0.1` 上免 token 的 `/health`。

## 工具

所有工具都标了只读（`readOnlyHint: true`），返回 JSON：`structuredContent` 是对象，`content[0].text` 是同一份 JSON 文本，字段与 [命令行 JSON](cli.md) 相同（`schemaVersion: 1`）。参数不对时返回 `isError: true` 和原因，Agent 可以据此改正重试。

| 工具 | 参数 | 返回 | 对应命令 |
|---|---|---|---|
| `get_status` | `includeQuota`（默认 `true`） | 今日合计、最紧的预算、最紧的额度窗口、一行摘要 | `status` |
| `get_usage` | `range`（`today` 默认、`week`、`month`、`year`、`all`），或 `from` + `to`（`YYYY-MM-DD`）；`by`（`agent`、`model`、`account`）；`agents`、`models`（字符串数组，筛选） | 合计与拆分 | `usage` |
| `get_quota` | 无 | 每个来源的额度窗口（已用、上限、剩余、剩余百分比、重置时间、状态，无限额度以 `reasonCode: credits_unlimited` 表明）与最紧的窗口 `tightest` | `quota`（去掉账号标签与操作按钮） |
| `get_budget` | 无 | 每条预算的已用、上限、百分比与级别（`ok`、`warn`、`over` 已超、`unavailable` 读不到） | `budget` |
| `get_gateway` | `limit`（1–50，默认 10） | 网关是否在运行、供应商与路由组数量、最近 N 条路由结果 | `gateway` |
| `get_anomalies` | 无 | 用量异常：Token/费用突增、缓存命中骤降、Agent/模型放量、昂贵会话、网关错误率突增，以及每类检查是否有足够历史（规则见 [usage-anomaly-v1](design/usage-anomaly-v1.md)） | 桌面「用量异常」面板 |

口径提醒（也写在服务的 `instructions` 里，Agent 连上时会读到）：有效 Token = 输入 + 输出，缓存读写单列，不并入有效 Token；费用是按价格表估算的美元。

## 提示词 `pace_usage`

可选参数 `threshold`：剩余额度百分比的阈值，默认 `20`（取值 1–90）。服务读取当前最紧的额度窗口和预算，返回一段给 Agent 的指引：

| 级别 | 条件 | 指引要点 |
|---|---|---|
| `conserve` | 最紧的额度剩余 ≤ 阈值，或有预算已超 | 先告诉用户额度紧张、大任务先确认；只读需要的片段；不重复长输出、不整文件重写；合并修改、回答简短；不开子 Agent |
| `watch` | 剩余 ≤ 阈值的两倍，或有预算到了提醒线 | 照常做但控制上下文；长任务前提一句剩余额度，做完再查一次 |
| `normal` | 其他 | 照常做，超长任务前再调一次 `get_status` |

在 Claude Code 里它显示为斜杠命令 `/mcp__tokenledger__pace_usage`，可以在开始一段长工作前手动运行，也可以在项目的 `CLAUDE.md` / `AGENTS.md` 里写一句「开始大任务前先调用 tokenledger 的 get_status，额度低于 20% 时按 pace_usage 的指引节制」。

## 配置示例

下面假设 `tokenledger-cli` 已在 `PATH` 里（安装位置见 [命令行文档](cli.md#构建与安装)）；不在的话把 `tokenledger-cli` 换成完整路径。Windows 上写成 `C:\\...\\tokenledger-cli.exe`（JSON 和 TOML 里反斜杠要写两个）。

数据目录默认与桌面端相同；要指向别的目录，加环境变量 `TOKENLEDGER_APPDATA`。

### Claude Code

```sh
# 所有项目都可用
claude mcp add --scope user tokenledger -- tokenledger-cli mcp
# 检查：应显示 Connected
claude mcp list
```

或者在项目根目录的 `.mcp.json` 里写：

```json
{
  "mcpServers": {
    "tokenledger": {
      "command": "tokenledger-cli",
      "args": ["mcp"]
    }
  }
}
```

### Codex CLI

```sh
codex mcp add tokenledger -- tokenledger-cli mcp
```

或者编辑 `~/.codex/config.toml`：

```toml
[mcp_servers.tokenledger]
command = "tokenledger-cli"
args = ["mcp"]
```

### Gemini CLI、Qwen Code

在 `~/.gemini/settings.json`（Qwen Code 为 `~/.qwen/settings.json`）里加：

```json
{
  "mcpServers": {
    "tokenledger": {
      "command": "tokenledger-cli",
      "args": ["mcp"]
    }
  }
}
```

### Cursor 及其他客户端

Cursor 用 `~/.cursor/mcp.json`，格式与上面的 `mcpServers` 相同。其他支持 stdio 的 MCP 客户端都按「命令 `tokenledger-cli`，参数 `mcp`」配置即可。

## 协议细节

- 传输：stdio，UTF-8，一行一条 JSON-RPC 2.0 消息；日志与错误只写标准错误。
- 协议版本：`2025-11-25`、`2025-06-18`、`2025-03-26`、`2024-11-05`。客户端请求其中之一就按它回，否则回最新的。2025-03-26 及更早版本的批量请求也支持。
- 能力：`tools`、`prompts`。`resources/list` 返回空列表。
- 不引入 MCP SDK：协议层是手写的 JSON-RPC（`src-tauri/src/mcp/`），只用核心库已有的 `serde_json`。

## 验证

- `cargo test --manifest-path src-tauri/Cargo.toml --lib mcp::` 覆盖握手与版本协商、错误码、工具参数校验、与命令行同数、额度去账号标签、异常去会话 ID、节制提示的级别。
- 用官方 TypeScript SDK 的 stdio 客户端连上后逐个调用工具与提示词，以及 `claude mcp list` 显示 Connected，都在云端容器里实测过；Codex 等其他客户端待验收工位在本机确认。
