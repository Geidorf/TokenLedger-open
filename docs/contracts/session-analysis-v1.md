# 本机会话逐轮分析 v1

这是桌面 Tauri 的独立、按需、只读接口，不属于 Dashboard Stats v2、额度 transport、持久账本或 Supabase RPC。Android 和云端明细没有此能力。

## 接口

- `get_local_session_analysis({ recordId, requestId })`：recordId 必须对应本机账本中已存在的记录；客户端不能提供文件路径。
- `cancel_local_session_analysis({ requestId })`：取消有界读取；前端关闭抽屉、切换记录或重新读取时取消旧请求，迟到响应不再写回。

响应固定为 `{ status, reason?, recordId, sessionId, tool, observedAt, turns, unassignedUsage?, coverage }`。

`status` 为 `ready | partial | unavailable`。`coverage` 包含 `complete/matchedRecord/toolCallsKnown`。`observedAt` 为本次读取时间，不是日志事件时间。仅当来源身份与所选记录的完整去重键匹配时，才能展示可用分析。

每轮包含 `id/ordinal/startedAt/endedAt/status/requestCount/inputTokens/outputTokens/cachedTokens/models/tools`，以及可选的 `cacheReadTokens/cacheWriteTokens`。时间可为 null；轮次状态为 `complete | in_progress | unknown`。`tools` 只含 `{ name, count }`。工具信息不完整时 `toolCallsKnown=false`，客户端不能把缺失解释为没有调用。

有效 Token = 输入 + 输出；缓存单列。缓存读写不可证明时不输出拆分字段；不把未知值补成 0。用量不能可靠归属到某轮时进入 `unassignedUsage`，保留请求数、输入、输出和缓存，同时响应为 partial。每轮可以有多次模型请求，账本行数不是用户轮次数。

## 可靠来源与隐私

首版只支持可证明用户边界的 Claude、Codex 主会话。工具结果、流式重复、同一用户事件副本和重复上下文不能开新轮。无法确认的 fork、子代理、回放或无用户边界日志返回不可用，不能猜测轮次。统计用量复用对应 scanner 规范化算法，不新增一套计数口径。

后端只在已支持的本地扫描根目录中定位，规范化路径、拒绝越界链接、匹配选中记录身份，并限制候选数、总字节、单行、轮次数和时间。读取期间源变化、候选冲突、文件缺失和超限均显式返回稳定 reason；不回显文件路径或原始异常。

分析需要读取原始日志文件字节，但正文、回答、工具参数、工具输出均通过白名单解析丢弃，不进入 DTO、持久化数据、云端或诊断日志。模型名和工具名作为不可信元数据受长度与字符限制。此功能不会重扫、修改或删除账本。

## 不可用原因

`record_not_found | unsupported_source | source_missing | source_changed | source_ambiguous | insufficient_turn_metadata | unsupported_session_shape | limit_exceeded | cancelled | invalid_request | source_unreadable`。

前端将原因本地化；未知原因只显示通用不可用，禁止直接渲染来源异常。整个会话快照不受打开时的明细时间／模型筛选截断，抽屉必须清楚说明这一点。

## 验证边界

匿名结构 fixture、Rust 单测和 Chromium 开发 mock 只能证明对应解析／呈现路径。真实供应商格式、原生 IPC、系统权限与 WebView2 行为须单独验证，不得把 mock 轮次称为真实用户会话结果。
