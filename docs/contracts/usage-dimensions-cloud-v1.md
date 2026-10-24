# 云端用量维度契约 v1：会话、账号、平均 Context 构成

状态：实施中（2026-10-24 起）。拥有者：Android 补齐桌面用量视图线程（claude@ld）。评审：B 级（迁移、RLS/RPC、同步格式）。方案与取舍见 `docs/design/cloud-usage-dimensions-v1.md`，负责人已按其第 9 节的建议答复（2026-10-24）。

桌面把本机已经算好的三个维度按本地日聚合后上传，Android 只读。云端不重新去重、不重新估价，口径与桌面本机 Stats v2 / 行为分析完全一致。

## 1. 边界

- **默认关闭。** 桌面设置里三个开关（会话、账号、Context 构成）默认全关，各自独立。开启前列出上传字段；关闭时先删除云端本人该维度的全部行，再停止上传。
- **只传聚合、大小与计数。** 不传提示词、回复、文件路径、工作目录、请求体及其哈希、凭据、令牌、cookie、原始会话 ID、用户自填的供应商标签。
- **云端只保留最近 90 天**（按 `local_date`，以服务器 UTC 日期减 90 天为界）。每次上传顺带删除本人过期行；每天一次的定时清理删除所有人的过期行。
- **不改 `token_logs` 与已有 RPC。** 三个维度各一张私有表，可单独清空、单独回滚。

## 2. 存储

三张表都在 `private` schema，客户端没有任何表权限，只能经 §3、§4 的 RPC 访问；都开启并强制 RLS（只读自己的行，作为纵深防御）；`user_id` 级联删除到 `auth.users`。

| 表 | 主键 | 列 |
| --- | --- | --- |
| `private.usage_session_days` | `(user_id, machine_id, local_date, session_key)` | `tool`、`tokens`、`requests`、`cost_usd`（可空）、`first_at`、`last_at`、`top_model`（可空） |
| `private.usage_provider_days` | `(user_id, machine_id, local_date, provider)` | `input_tokens`、`output_tokens`、`cached_tokens`、`cache_write_tokens`、`requests`、`cost_usd`（可空） |
| `private.usage_context_days` | `(user_id, machine_id, local_date)` | `requests`、`prompt_tokens`、`system_bytes`、`tools_bytes`、`history_bytes`、`tool_results_bytes`、`attachments_bytes`、`messages`、`tool_results`、`attachments` |

公共列：`user_id uuid`、`machine_id text`（与该设备 `token_logs.machine_id` 相同，1–128 字符）、`local_date date`、`received_at timestamptz default clock_timestamp()`。

约束：计数与字节为非负 `bigint`；`requests ≥ 1`；`cost_usd` 为空或有限且 ≥ 0；`session_key ~ '^[0-9a-f]{32}$'`；`tool`、`top_model` 1–128 字符；`first_at`、`last_at` 为 `HH:MM`（本地墙钟，截到分钟），`first_at ≤ last_at`；`provider` 必须在 §2.1 名单内或为 `other`。

### 2.1 账号名白名单

`provider` 只能是下列规范名之一（小写），名单外一律写 `other`。桌面按网关记录的 `provider` 去首尾空白、转小写后精确匹配；云端再校验一次，不在名单里就拒绝整批。

```
anthropic ark deepseek gemini glm groq kimi lmstudio mistral ollama openai openrouter qwen siliconflow xai other
```

多个自建账号会合并到同一个 `other`（用户决定）。

### 2.2 会话键

`session_key = hex(HMAC-SHA256(本机密钥, tool + "\n" + 原始会话 ID))` 的前 16 字节（32 个十六进制字符）。本机密钥 32 字节随机数，存在系统安全存储，不上传、不经设备同步共享，所以同一会话在两台设备上是两个键，Android 不跨设备合并（用户决定）。重装丢失密钥后新旧键不同，旧行 90 天后过期。缺少会话 ID（空、纯空白、`unknown_session`）的记录不进会话表。

## 3. 写入

### 3.1 `public.sync_usage_dimensions_v1(p_payload jsonb) → jsonb`

`security definer`、空 `search_path`，只认 `auth.uid()`；匿名调用报 `usage_dimensions_identity_required`（42501）。

```json
{
  "v": 1,
  "machine": "<token_logs.machine_id>",
  "sessions": { "days": [ { "date": "2026-10-24", "truncated": false, "rows": [
    { "key": "<32 hex>", "tool": "codex", "tokens": 550, "requests": 3, "cost": 0.27, "firstAt": "08:00", "lastAt": "11:15", "topModel": "gpt-5" }
  ] } ] },
  "providers": { "days": [ { "date": "2026-10-24", "rows": [
    { "provider": "openai", "input": 400, "output": 50, "cached": 500, "cacheWrite": 0, "requests": 6, "cost": 0.12 }
  ] } ] },
  "context": { "days": [ { "date": "2026-10-24",
    "row": { "requests": 6, "promptTokens": 900, "systemBytes": 0, "toolsBytes": 0, "historyBytes": 0, "toolResultsBytes": 0, "attachmentsBytes": 0, "messages": 0, "toolResults": 0, "attachments": 0 } } ] }
}
```

- 三个维度各自可省略；省略的维度不动。
- 对出现的每个维度、每个 `date`：先删除本人、该 `machine`、该日、该维度的全部行，再插入 `rows`（`rows` 为空数组或 `row` 为 `null` 即表示当天没有数据）。同一批内的整体替换在一个事务里完成，重复上传结果相同。
- `date` 必须在「服务器 UTC 日期 − 90 天」到「服务器 UTC 日期 + 1 天」之间；更早的日直接拒绝，不静默丢弃。
- 上限：每个维度最多 92 个 `date`；会话每日最多 500 行（桌面按有效 Token 取前 500，余量照常计入总量，并把该日 `truncated` 置 true）；整批最多 10000 行；`p_payload::text` 不超过 2 MiB。
- 拒绝时 errcode 22023，消息 `usage_dimensions_<原因>`，原因为 `invalid_payload`、`payload_too_large`、`date_out_of_range`、`provider_not_allowed`。
- 返回 `{"stored": {"sessions": <行数>, "providers": <行数>, "context": <行数>}, "purged": <删除的过期行数>, "retentionDays": 90}`。

### 3.2 `public.clear_usage_dimension_v1(p_dimension text) → jsonb`

`p_dimension` 为 `sessions`、`providers`、`context` 之一，删除本人该维度在所有设备上的全部行，返回 `{"deleted": <行数>}`。其他值报 `usage_dimensions_invalid_payload`。

## 4. 读取：`public.get_usage_dimensions_v1(p_query jsonb) → jsonb`

查询沿用 Stats v2 查询（`private.tokenledger_normalize_query_v2`），区间按本地日解释；`machines`、`tools` 筛选生效。`models` 筛选非空时三个维度都标为 `filtered`（云端行不带逐模型拆分，不拿未筛选的数当筛选结果）；会话维度还受 `tools` 筛选，账号与 Context 维度带 `tools` 筛选时同样标 `filtered`。

```json
{
  "meta": { "source": "cloud", "start": "2026-10-01", "end": "2026-10-24", "timezone": "Asia/Shanghai", "retentionDays": 90, "coverageStart": "2026-07-26" },
  "sessions": { "state": "ok", "sessionCount": 120, "truncatedDays": 0, "sessionLimit": 100,
    "rows": [ { "id": "<session_key>", "machine": "MacBook-Pro", "tool": "codex", "tokens": 550, "requests": 3, "cost": 0.27, "days": 2, "firstDate": "2026-10-23", "lastDate": "2026-10-24", "firstAt": "08:00", "lastAt": "11:15", "topModel": "gpt-5" } ] },
  "providers": { "state": "ok", "rows": [ { "provider": "openai", "input": 400, "output": 50, "cached": 500, "cacheWrite": 0, "total": 950, "requests": 6, "cost": 0.12 } ] },
  "contextComposition": { "state": "ok", "requests": 6, "promptTokens": 900, "systemBytes": 0, "toolsBytes": 0, "historyBytes": 0, "toolResultsBytes": 0, "attachmentsBytes": 0, "messages": 0, "toolResults": 0, "attachments": 0 }
}
```

- `state`：`ok`（有行）、`empty`（区间内本人没有任何该维度的行，可能是桌面没开开关，也可能是真的没用量；客户端统一提示「桌面开启后可见」）、`filtered`（见上，此时不带其他字段）。
- 会话：同一 `(machine, session_key)` 跨日合并：`tokens`、`requests` 相加；`cost` 任一天为空则为空；`firstDate/firstAt` 取最早、`lastDate/lastAt` 取最晚；`topModel` 取合并后 Token 最多那天的 `top_model`；`days` 为出现天数。按 `tokens` 倒序、`id` 升序取前 100；`sessionCount` 为合并后的完整会话数；`truncatedDays` 为区间内 `truncated` 为真的设备日数。
- 账号：按 `provider` 在区间与设备筛选内求和，`total = input + output`；`cost` 任一行为空则为空。按 `total` 倒序，`other` 排最后。只统计经网关的请求，各账号合计可以小于看板总量，客户端必须写明。
- Context 构成：区间与设备筛选内逐列求和，含义与 `dashboard-stats-v2` §2.8 相同（平均值由客户端用 `requests` 相除）。
- `meta.coverageStart` 为「服务器 UTC 日期 − 90 天」；查询区间早于它的部分没有数据，客户端写明「云端只保留最近 90 天」。

## 5. 客户端行为

- **桌面**：随现有云同步批次上传，不新增定时器。开启某维度后第一次上传补齐最近 90 天，此后每轮只重传今天、昨天与本轮有新记录的日。每日数据直接取本机 Stats v2（`providers`、`contextComposition`）与本机行为分析（`sessions`），查询为该日单日自定义范围、设备筛选为本机，保证与本机看板同一口径。RPC 不存在（PGRST202）时标为「云端未部署」，5 分钟后再试，不影响 `token_logs` 同步。
- **Android**：调用 `get_usage_dimensions_v1`；PGRST202 显示「云端还没开通」；`empty` 提示去桌面「设置 › 数据与帮助」开启；不从 `token_logs` 推算任何一个维度。

## 6. 发布与回滚

- 迁移与回归测试接入 `supabase:verify:release`；负责人执行 `supabase db push`。
- 回滚：删除三个 RPC、清理任务与三张表；旧客户端不调用，不受影响。

## 7. 变更记录

- 2026-10-24：v1 初版。账号名用白名单、三项默认关闭、云端保留 90 天、会话不跨设备合并（负责人答复设计文档第 9 节）。
