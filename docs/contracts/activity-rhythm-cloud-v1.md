# 云端活动节律契约 v1（2026-10-24）

## 范围与事实源

`public.get_activity_rhythm_v1(p_query jsonb)` 是只读 Supabase RPC，供 Android（以及桌面云端模式）在没有本机账本时显示「活动节律」：工具分布、日期×小时、小时×模型、日期×模型。它是本机行为分析（[behavior-analysis-local-v1](behavior-analysis-local-v1.md)）在云端数据允许范围内的同形子集，不是它的替代。

- 事实源是 `public.token_logs`：桌面上传的小时聚合（设备 × 工具 × 模型 × 小时），`session_id` 恒为 `agg`。云端没有会话、单条请求与请求大小，所以本契约**不输出** `sessions`、`summary.sessionCount`、`tools[].sessionCount`、`requestSizes`、会话费用与项目维度；读者不得从本 RPC 推断这些。
- 迁移：`supabase/migrations/20261024030000_cloud_heatmap_metrics_and_activity_rhythm.sql`；回归：`supabase/tests/cloud_heatmap_metrics_activity_rhythm_regression.sql`（已接入 `supabase:verify:release`）。

## 调用与权限

- 只授予 `authenticated`；`public`、`anon` 无执行权限。`SECURITY DEFINER`，`search_path` 为空。
- 没有 `p_user` 参数：所有者恒为 `auth.uid()`，为空时报 `42501`。只读本人的行。
- `p_query` 与 Stats v2 同一 canonical 校验（`private.tokenledger_normalize_query_v2`）：`range`（`today | week | month | year | all | custom`）、`start`/`end`（仅 custom，`YYYY-MM-DD`，闭区间，最长 731 天，起点不晚于今天）、`timezone`（IANA）、`machines[]`、`tools[]`、`models[]`、`search`、`tokenMode`。非法输入报 `22023`，规则见 [dashboard-stats-v2](dashboard-stats-v2.md) §4。`tokenMode` 只做校验与回显，本 RPC 的 `tokens` 恒为有效 Token。

## 响应

```json
{
  "meta": {
    "source": "cloud",
    "contractVersion": 1,
    "granularity": "hour",
    "complete": true,
    "range": "custom",
    "start": "2026-09-01",
    "end": "2026-09-23",
    "timezone": "Asia/Shanghai",
    "rangeDayLimit": 731,
    "rangeTruncated": false,
    "recordCount": 0,
    "firstRecordAt": null,
    "lastRecordAt": null,
    "query": {},
    "generatedAt": "2026-10-24T03:04:01.710228+00:00"
  },
  "summary": { "tokens": 0, "inputTokens": 0, "outputTokens": 0, "cachedTokens": 0, "requests": 0, "activeDays": 0, "toolCount": 0, "modelCount": 0 },
  "tools": [{ "id": "Codex", "tokens": 0, "requests": 0 }],
  "dayHours": [{ "date": "2026-09-23", "hour": 10, "tokens": 0, "requests": 0 }],
  "modelHours": [{ "hour": 10, "model": "model-name", "tokens": 0, "requests": 0 }],
  "modelDays": [{ "date": "2026-09-23", "model": "model-name", "tokens": 0, "requests": 0 }]
}
```

### 口径

- 有效 Token：`tokens = inputTokens + outputTokens`；`cachedTokens` 单列观察，不并入 `tokens`。
- `requests` 与 `meta.recordCount` 是入选聚合行 `requests` 列之和（界面称「记录数」），不是聚合行数。网关合并上传的行同样计入，口径与看板 `summary.totalRequests` 一致。
- `summary.activeDays` 是有入选行的本地日期数；`toolCount`/`modelCount` 是入选行里不同工具/模型的个数。
- 日期与小时：`token_logs.timestamp` 是桌面上传的墙钟时间文本（`YYYY-MM-DD HH:MM:SS`，小时聚合时分秒为整点），与 Stats v2 的 `heatmap`、`trends` 一样按所请求时区的本地墙钟解释，日期取前 10 位，小时取第 12–13 位（0–23）。`dayHours` 按本地日期与小时分桶；`modelHours` 是所选范围内同一小时的跨日合计；`modelDays` 按本地日期与模型分桶。日期或小时无法解析的行只计入 `summary` 与 `tools`，不进入三个分桶数组。
- `firstRecordAt`/`lastRecordAt` 是入选行时间文本的最小值、最大值；云端是小时聚合，所以精度到小时起点。无记录时为 `null`。

### 排序与零值

- `tools` 按 `tokens` 倒序，相同时按 `id` 字节序升序。
- `dayHours` 按 `(date, hour)` 升序；`modelHours` 按 `(hour, model)` 升序；`modelDays` 按 `(date, model)` 升序（模型名字节序）。
- 只输出有入选行的桶，零值桶由读者按 `meta.start..meta.end` 与 0–23 时补齐。可信空集返回空数组与 0，不报错。

### 范围

- 预设范围与 Stats v2 同义：`today` 今日 0 点、`week` 本周一 0 点、`month` 本月 1 日、`year` 1 月 1 日，均截至当前时刻；`custom` 为所选本地日期闭区间，跨越「现在」时截到现在。
- `all` 只覆盖截至今天、含今天的最近 `meta.rangeDayLimit`（731）个本地日历日，与本机契约 v1.1 相同。窗口之前仍有符合同一过滤的行时 `meta.rangeTruncated = true`，`meta.start` 为窗口首日，界面须注明「仅统计最近 731 天」；否则 `meta.start` 是最早入选行的日期（无记录时为今天）。其它范围 `rangeTruncated` 恒为 false。
- `meta.start/end` 是实际分析的本地日期，界面以它为准显示区间。

## 兼容与演进

- 新增 RPC，不改任何旧签名与旧响应；未部署该迁移的云端调用会得到「函数不存在」错误，读者按「云端不支持活动节律」显示能力边界，不得从看板 `history`（最多 200 条）推断全量节律。
- 后续只增字段：缺失的新字段表示实现不支持，不得解读为 0。会话、账号与 Context 构成的云端维度另见方案 [cloud-usage-dimensions-v1](../design/cloud-usage-dimensions-v1.md)（未实施）。

## 部署与回滚

- 部署：负责人执行 `supabase db push`。
- 回滚：`drop function public.get_activity_rhythm_v1(jsonb);`。看板部分的回滚见 [supabase/README.md](../../supabase/README.md) 对应一节。

## 版本记录

- 2026-10-24 v1：首版。
