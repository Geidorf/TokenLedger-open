# 网关路由决策解释链（v1）

状态：实施中（2026-10-23 起）。适用平台：桌面端主窗口（网关页「最近请求」、路由页「最近路由决策」与实时路由动画的节点提示）。来源：用户要求每次组路由都能说清每个成员为什么被选中或被跳过。

## 不做的事

- **不进挂件**：挂件窗口读的 `gateway_routing_feed` 继续只给成员、结果与状态码，不带解释链（解释里可能有上游错误正文）。
- **落盘只为请求日志**：解释链和 RouteDecision 在内存环形缓冲里（最多 200 条）；自 2026-10-24 起另写一份不含会话 ID 的 `route-decisions-v1.jsonl`（4 MB 轮转），只供主窗口的请求日志查看器读取，见 [gateway-request-log-v1](gateway-request-log-v1.md)。
- **不推测**：只写网关这次真的看到的事实。没有尝试过的成员写「未轮到」，不猜它是否可用。

## 数据

`RouteDecision.trace` 每个组成员一条：先按候选顺序列出排入计划的成员，再列出计划之外的成员。旧版本记录没有这个字段，界面退回到逐次尝试列表。

| 字段 | 说明 |
| --- | --- |
| `member` | `供应商/模型` |
| `rank` | 候选序号（从 0 起）；计划之外为 `null` |
| `verdict` | `chosen` 选中 · `failed` 失败已切换 · `rejected` 上游拒绝 · `skipped` 跳过 · `not_reached` 未轮到 · `excluded` 未参与 |
| `reasons` | 机读码，先写为什么排在这里，再写这次尝试的结果 |
| `detail` | 中文短说明（规则描述或上游错误，最多 200 字） |

原因码（界面对未知码原样显示，新增码只需在 `src/features/gateway/helpers.ts` 补中文）：

- 排位：`rule_match` 命中规则、`affinity` 会话保持、`strategy_first` 策略首选、`rotate_turn` 轮到它、`weighted_pick` 按权重选中、`manual_pick` 固定成员、`fallback` 备选、`nested` 来自子组。
- 尝试结果：`answered` 已响应、`rate_limited` 限流（429）、`quota_exhausted` 额度用尽（402，或 429 且错误里提到额度/余额）、`connect_failed` 连接失败、`upstream_failed` 上游出错（5xx）、`upstream_rejected` 上游拒绝、`auth_failed` 鉴权失败（401/403）、`provider_missing` 供应商不存在、`key_missing` 未设置 Key、`protocol_unsupported` 协议不支持、`credential_unavailable` 凭据不可用、`not_reached` 前一个已响应。
- 计划之外：`manual_only` 固定分配只用一个、`cooling_down` 冷却中、`unhealthy` 健康检查未过、`disabled` 已停用、`not_planned` 未排入候选。

策略在排计划时剔除成员（冷却、额度、健康），往 `Plan.excluded` 推一条 `{member, reason, detail}` 即可，解释链由 `routing.rs` 的 `build_trace` 统一拼装。

## 界面

- 网关页「最近请求」：组请求的「实际转发」旁显示一句话原因（有问题先说问题，否则说为什么排在这里），点开在下一行列出全部成员。
- 路由页「最近路由决策」：每条决策下有「为什么这样选（N 个成员）」折叠区。
- 实时路由动画：上游节点的悬停提示带上最新一条流里它的一句话原因（仅主窗口）。
