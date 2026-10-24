# 网关请求日志查看器（v1）

状态：实施中（2026-10-24 起）。适用平台：桌面端主窗口（模型接入 · 网关 → 请求日志）。来源：用户要求能按条查看经自带网关的每次请求，说清路由原因、重试切换、Token、费用与耗时。

## 不做的事

- **不存内容**：只读写元数据。请求与回复正文、提示词、工具参数、附件一律不落盘、不进日志、不进导出。Context 构成只有各部分序列化后的字节数与条数（见 [request-context-composition-v1](request-context-composition-v1.md)）。可选的内容采样另见 [gateway-content-sampling-proposal-v1](gateway-content-sampling-proposal-v1.md)，**未实现**，方向已评审认可，实现另开 B 级 PR。
- **不进挂件**：两个新命令只允许主窗口调用；挂件继续只读脱敏的 `gateway_routing_feed`。
- **不改记账**：费用与 Token 合计仍以 `usage-accounting-v1.sqlite3` 和用量页为准；请求日志读的是会轮转的诊断日志，最多约 32 MB（当前与上一份 `usage-v1.jsonl`），更早的请求只留在用量统计里，页面写明「本机保留 N 条（最早 …）」。

## 数据

### 诊断日志新增字段

`usage-v1.jsonl` 每行（`LedgerRecord`）新增可选字段 `firstTokenMs`：本次尝试从发出到收到第一个带输出的上游流事件的毫秒数。带输出指 Chat 的 `delta.content` / `reasoning_content` / `reasoning` 非空或有 `tool_calls`、Responses 的 `response.*.delta`、Anthropic 的 `content_block_delta`；`response.created`、`message_start`、只带用量的事件不算。非流式请求不写。旧行没有这个字段，照常解析。

### 路由决策落盘

路由组请求的决策（原因、逐次尝试、解释链 trace）原本只在内存环形缓冲（200 条），网关重启后清空。现在另写一份 `route-decisions-v1.jsonl`（网关目录下，超过 4 MB 轮转为 `.1`，最多约 8 MB），按逻辑请求 ID 与诊断日志关联。落盘内容与 `RouteDecision` 相同但**不含会话 ID**（诊断日志里已有，避免多存一份）；尝试的错误说明沿用内存版的 200 字上限。写失败只记警告，不影响请求。读取时先用文件里的决策，缺的再用内存里的。

### 逻辑请求

同一 `logicalRequestId` 的多行（重试、切换）合成一条；旧行没有逻辑 ID 时各自成一条。路由组里被跳过的成员（供应商已删除或停用，网关没有发出请求，因而没有账本行）按路由决策的顺序补成零用量的诊断尝试（状态 404），参与最终结果、供应商与模型筛选、筛选候选和导出，但不写回会计账本；全部成员都被跳过的组请求只凭决策单独成一条。因协议不支持或缺 Key 被跳过的成员网关已照常记了账本行（400 / 401），沿用账本里的状态，不再补占位。字段：

| 字段 | 口径 |
| --- | --- |
| `startedAt` / `ts` | 第一次尝试开始（结束时间 − 耗时）/ 最后一次尝试结束 |
| `provider` / `upstreamModel` / `status` / `ok` / `error` | 最后一次尝试，即客户端实际收到的回复 |
| `latencyMs` | 从第一次尝试开始到最后一次结束的墙钟时间，含重试 |
| `firstTokenMs` | 最后一次尝试开始前已用的时间 + 该次的首字耗时；客户端视角的首字等待 |
| `outputTps` | 最后一次尝试的输出 Token ÷（耗时 − 首字耗时）；非流式按整次耗时 |
| Token | 各次尝试相加（失败尝试上游可能也报了用量，照实计入） |
| `costUsd` | 每次尝试按本机生效价格表估算后相加；未知模型走工具兜底价或 `default`，与用量页一致 |
| `retries` / `switched` | 尝试次数 − 1 / 是否换过供应商或模型 |
| `decision` | 路由组请求的决策与解释链；直连请求为空 |

## 命令

两个只读命令，仅主窗口（`gateway-main-only`），后台线程执行，命令总数 113 → 115：

- `gateway_request_log(query)` → `{entries, total, offset, retained, oldest, facets}`。筛选：`since`/`until`（RFC 3339）、`agent`、`provider`（任一次尝试命中）、`model`（请求模型、上游模型或 `供应商/模型`）、`status`（`ok`、`error`、`4xx`、`5xx`、`retried` 或具体状态码）、`minLatencyMs`/`maxLatencyMs`、`search`（不区分大小写，匹配请求 ID、会话、Agent、模型、供应商、路由组、错误说明，最多 120 字）；`offset` + `limit`（默认 50，最多 200）。`facets` 给筛选下拉框用，来自全部保留请求。
- `gateway_request_log_export(query)` → `{message, path}`：同一筛选、不分页，写到应用数据目录的固定文件 `tokenledger_gateway_requests.csv`（带 BOM），前端给不了路径。单元格沿用已有 CSV 导出的公式前缀中和。每条逻辑请求一行，尝试顺序与解释链各压成一列（`供应商/模型:状态 > …`、`成员=结论[原因码+…]; …`）。

## 界面

- 入口：网关页「最近请求」卡片右上「打开请求日志」；也可直接打开 `#gatewaylog`。顶栏仍高亮「网关」。
- 筛选条：时间范围（1 小时 / 24 小时 / 7 天 / 全部）、Agent、供应商、模型、状态、耗时、搜索（300 ms 防抖），右侧「实时尾随」「刷新」「导出 CSV」。
- 表格列：时间、Agent、模型、实际转发（带「切换 N / 重试 N」与一句话路由原因）、状态、有效 Token、费用、首字、耗时、输出速度。点时间展开详情：尝试顺序（每次的成员、状态、耗时、首字、Token、费用、错误）、为什么这样路由（复用解释链组件 `DecisionTrace`）、Token 与费用、Context 构成（与用量页同一色板）、请求信息。
- 实时尾随：开启后回到第一页，每 2 秒重新读取，窗口隐藏时跳过；新到的行短暂高亮（减少动态效果时不动画）。翻到下一页自动退出尾随。
- 空状态：没有任何请求 / 没有符合条件的请求（可一键清空筛选）。

## 后续

- 供应商健康度（provider-health-v1）合入后，在详情的尝试行旁显示该供应商当前健康状态。
- 诊断日志很大时可按文件大小与修改时间缓存解析结果；v1 每次全读两份文件（最多约 32 MB，后台线程）；持账本锁时只读字节，解析在锁外，记账追加不会等解析。
