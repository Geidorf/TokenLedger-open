# 逐请求 Context 构成（v1）

状态：方案，2026-10-23。适用平台：桌面本机（网关记录）。上级方案：用量分析对齐方案（第 3 步请求子页指标）。

## 目标

请求子页展开一条网关记录时，说明这次请求的输入由哪些部分组成：系统提示、工具定义、对话历史、工具结果、附件。用户能看出输入 Token 主要花在哪里，例如工具定义过大、工具结果堆积，从而决定是否精简。

## 边界

- 只量大小，不留内容：网关转发请求时已经解析请求体，这里只数各部分序列化后的 UTF-8 字节数和条数。不保存文本、不保存哈希，也不写诊断日志里的原文。
- 不读取任何订阅凭据，不调用未公开接口（ADR-004、ADR-017）。数据只来自网关本来就转发的请求体。
- 扫描记录、导入记录和云端没有请求体，不带构成，界面写明不可得，不推算。
- 字节数是实测值。Token 数是估算：按字节占比分摊这次请求实测的输入合计（输入 + 缓存读 + 缓存写），界面标「估算」。分词器因模型而异，不在本机跑分词器。

## 分段

按请求进入网关时的原始接口统计（转换到上游接口之前），三种接口映射到同一组分段：

| 分段 | Messages | Chat Completions | Responses | Gemini |
| --- | --- | --- | --- | --- |
| `system` | `system` | `role=system/developer` 的消息 | `instructions` 与 `role=system/developer` 的条目 | `systemInstruction` |
| `tools` | `tools` | `tools`、`functions` | `tools` | `tools` |
| `history` | `user`、`assistant` 消息里的文本与工具调用块 | `user`、`assistant` 消息（含 `tool_calls`） | `message`、`function_call` 与其他条目 | `contents` 里的其他 part |
| `toolResults` | `tool_result` 块 | `role=tool/function` 的消息 | `function_call_output`、`custom_tool_call_output` 条目 | `functionResponse` part |
| `attachments` | `image`、`document` 块 | `image_url`、`input_audio`、`file` 内容 | `input_image`、`input_file` 内容 | `inlineData`、`fileData` part |

Gemini 请求在转换为 Chat 之前量取。不认识的块按所在消息计入 `history`。每段记字节数与条数（消息或块的个数），附件内容按其 JSON 原长计，不解码 base64。

## 存储

- 网关会计账本新增表 `context_rows(accounting_id TEXT PRIMARY KEY, system_bytes, tools_bytes, history_bytes, tool_results_bytes, attachments_bytes, messages, tool_results, attachments)`，所有列为非负整数。和 `accounting_rows` 一样按 `accounting_id` 去重，失败转移的多次尝试只记成功那次。
- 不升 `user_version`，也不改 `accounting_rows`：旧版本打开账本时看不到新表，照常工作，降级不丢数据。
- 诊断日志 `LedgerRecord` 增加可选 `context` 对象（同上字段），旧读者忽略。

## 契约与读取

- `dashboard-stats-v2.md` §2.5：本机明细的网关行可带可选 `context`：`{ systemBytes, toolsBytes, historyBytes, toolResultsBytes, attachmentsBytes, messages, toolResults, attachments }`。其他来源不带。B 级评审。
- 读取账本分页时左连接 `context_rows`，构成随网关行进入本机统计连接的 `temp.gw_rows`（JSON 文本列），只在明细项输出，不进汇总、不进云同步。

## 界面

- 请求子页展开行增加「Context 构成」：一条按分段着色的横条，旁边列各段估算 Token 与占比；悬停显示实测字节数与条数。没有构成时不显示该块。
- CSV 增加 `context_system_bytes` 等五列字节数，缺失留空。
- 概览「消费洞察」里显示「平均 Context 构成」（2026-10-24 补做第 3 步）：后端给出本期带构成的网关记录的构成与输入合计（契约 §2.8），前端除以请求数，画同样的分段横条与估算 Token，并写明基于多少次经网关的请求。没有带构成的记录时不显示。

## 分步

1. 网关侧量取与存储（`gateway/context_size.rs`、`context_rows` 表、诊断日志字段），单元测试覆盖四种接口和未知块。
2. 明细输出 `context`，契约 §2.5 扩展，前端展开行与 CSV。
   （1、2 同一个 PR 完成。）
3. 概览的平均构成：契约 §2.8 `contextComposition`，概览面板复用展开行的横条组件。
