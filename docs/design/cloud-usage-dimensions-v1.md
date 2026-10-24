# 云端用量维度：会话、账号与平均 Context 构成（v1）

> **状态：方案，未实施。** 2026-10-24。适用平台：桌面（上传）、Supabase（存储与 RPC）、Android（只读）。本文不改任何契约、迁移或代码；落地前需负责人答复第 9 节的待定问题，并按 B 级（迁移、RLS/RPC、同步格式）另开任务。

## 1. 背景

Android 只读云端看板，事实源是 `public.token_logs` 的小时聚合（设备 × 工具 × 模型 × 小时，`session_id` 恒为 `agg`）。迁移 `20261024030000_cloud_heatmap_metrics_and_activity_rhythm` 之后，云端已能给出热力图的逐日记录数与费用（契约 `dashboard-stats-v2` §2.6）和活动节律（`activity-rhythm-cloud-v1`）。桌面还有三个视图 Android 画不出来，因为云端没有对应数据：

| 桌面视图 | 本机事实源 | 云端缺什么 |
|---|---|---|
| 会话列表（行为分析的会话排行） | 扫描记录的 `session_id`，见 `behavior-analysis-local-v1` | 小时聚合把会话合并掉了 |
| 按账号拆分（网关供应商） | 网关账本的 `provider`，见 `dashboard-stats-v2` §2.7 | 上传的聚合行不带 `provider` |
| 平均 Context 构成 | 网关 `context_rows` 字节数，见 §2.8 与 `request-context-composition-v1` | 构成只在本机明细里 |

本方案只回答一件事：桌面最少要额外上传什么，Android 才能画这三个视图，同时不突破隐私边界和 Supabase 免费档容量。

## 2. 原则

- **只传聚合，不传逐请求。** 与 `gateway-cloud-sync-v1` 的结论一致：逐请求上传一年可达百万行级，超出免费档；聚合行与现有 `token_logs` 同量级。
- **只传大小与计数，不传内容。** 不上传提示词、回复、文件路径、工作目录、请求体或其哈希；不上传任何凭据、令牌、cookie。
- **桌面先合并去重再上传。** 去重规则沿用 `dashboard-stats-v2` §2.5，云端不再去重，口径自动与本机一致。
- **每个维度一张独立表，可单独关闭、单独回滚。** 不给 `token_logs` 加列，避免改动所有旧 RPC 的聚合语义。
- **默认关闭，用户显式开启。** 三个维度在设置「数据与帮助」里各有开关，开启前展示上传字段清单。关闭后桌面停止上传并删除云端对应行。

## 3. 各维度上传什么

### 3.1 会话（按日）

新表 `public.usage_session_days`，每用户每设备每会话每本地日一行：

| 列 | 含义 |
|---|---|
| `user_id` | 所有者，默认 `auth.uid()` |
| `machine_id` | 与 `token_logs.machine_id` 相同的设备标识 |
| `session_key` | 不透明会话键：`HMAC-SHA256(每用户随机密钥, 工具 + 原始会话 ID)` 的前 16 字节十六进制。密钥只存本机安全存储，云端与其他设备无法反推原始会话 ID |
| `tool` | 工具名 |
| `local_date` | 本地日期 `YYYY-MM-DD`（与 `token_logs.timestamp` 同一墙钟） |
| `input_tokens` / `output_tokens` / `cached_tokens` | 当天该会话合计 |
| `requests` | 当天该会话记录数 |
| `cost_usd` | 当天该会话预估费用，可空（不可得时为空，不写 0） |
| `first_at` / `last_at` | 当天该会话首末记录时间，截到分钟 |
| `top_model` | 当天有效 Token 最多的模型，可空 |

- 缺少会话 ID（空、空白、`unknown_session`）的记录不进此表，Android 用 `token_logs` 总量减去会话合计得到「缺少会话 ID」的部分，规则同 `behavior-analysis-local-v1` v1.1。
- 跨日会话按日拆行；Android 显示会话时按 `session_key` 跨日合并。
- 多设备同一 HMAC 密钥才能跨设备合并同一会话；首版每台设备各自生成密钥，跨设备不合并（见第 9 节问题 2）。
- RPC：`get_session_list_v1(p_query jsonb)`，返回按有效 Token 倒序的前 100 个会话与完整区间会话数，形状对齐本机 `sessions[]`，`id` 为 `session_key`。

### 3.2 账号（网关供应商，按小时）

新表 `public.usage_provider_hours`，与 `token_logs` 同粒度：`user_id`、`machine_id`、`provider_key`、`tool`、`model`、`hour_bucket`、`input_tokens`、`output_tokens`、`cached_tokens`、`cache_write_tokens`、`requests`、`cost_usd`。

- 只包含经 §2.5 去重后保留、且 `provider` 非空的网关与导入记录；扫描记录没有账号，不进此表。各账号合计可以小于 `token_logs` 总量，Android 必须写明「仅统计经网关的请求」。
- `provider` 是用户在外部网关里自填的标签，可能含个人信息（如邮箱前缀、公司名）。两种处理二选一（第 9 节问题 1）：
  - **A. 哈希加本机别名**：上传 `provider_key = HMAC(用户密钥, provider)`，另在桌面把用户确认过的显示名以单独字段 `provider_label` 上传（用户可留空，留空时 Android 显示「账号 1/2/…」）。
  - **B. 白名单**：只上传落在内置供应商名单里的名字（例如官方 API 的规范名），其余归为「其他」。实现简单，但用户自建的多个账号会被合并。
- RPC：在 `get_dashboard_stats_v2` 上按 §2.7 同形输出可选顶层 `providers`，或单开 `get_provider_split_v1`。倾向后者，避免旧看板 RPC 再变重。

### 3.3 平均 Context 构成（按日）

新表 `public.usage_context_days`：`user_id`、`machine_id`、`local_date`、`requests`、`prompt_tokens`、`system_bytes`、`tools_bytes`、`history_bytes`、`tool_results_bytes`、`attachments_bytes`、`messages`、`tool_results`、`attachments`，全部非负整数，含义与 §2.8 `contextComposition` 相同，只是按日求和。

- 只记大小与条数。日粒度足够算区间平均，且不暴露单次请求的大小分布。
- RPC 在区间内求和后返回与 §2.8 同形的对象；没有行时不返回该字段。

## 4. 容量与上限

| 表 | 每用户每年量级 | 上限 |
|---|---|---|
| `usage_session_days` | 重度用户每天约 50 个会话 × 设备数，约 2 万行 | 每用户每设备每日最多 500 行，超出按有效 Token 取前 500，余量计入「缺少会话 ID」并在响应里标 `truncated` |
| `usage_provider_hours` | 每小时每设备「账号 × 工具 × 模型」行，通常远少于 `token_logs` | 每用户最多 32 个不同 `provider_key`，超出归「其他」 |
| `usage_context_days` | 每设备每日 1 行，约 365 行 | 无需额外上限 |

- 字段长度：`tool`、`model` 沿用 `token_logs` 的长度约束；`session_key`、`provider_key` 固定 32 个十六进制字符；`provider_label` 不超过 40 字节。
- 写入用与 `token_logs` 相同的 `on_conflict` 幂等 upsert，桌面每批不超过 500 行。

## 5. 权限与 RLS

- 三张表都开 RLS，策略与 `token_logs` 相同：`authenticated` 仅能增删改查 `auth.uid() = user_id` 的行；`anon` 与 `public` 无任何表权限。
- 读取只经 `SECURITY DEFINER`、空 `search_path` 的 RPC，所有者恒为 `auth.uid()`，查询校验复用 `private.tokenledger_normalize_query_v2`。客户端不持有 service role。
- 检查约束：计数与字节非负、`requests ≥ 1`、`first_at ≤ last_at`、键为 32 位十六进制。

## 6. 保留与删除

- 与 `token_logs` 相同的保留期；用户删除设备或清空云端数据时一并删除三张表的对应行（`on delete cascade` 到 `auth.users`，设备级删除由现有清理 RPC 扩展）。
- 关闭某个维度的开关：桌面调用对应的 `clear_*_v1()` 删除本人该维度全部行，再停止上传。
- 本机 HMAC 密钥丢失（重装）后，新旧 `session_key` 不再相同；旧行按保留期自然过期，不尝试迁移。

## 7. 上传节奏

- 随现有小时聚合同步同一批次上传，不新增定时器；只上传有变化的日或小时桶（复用现有脏桶标记）。
- 网关维度依赖本机合并结果，与 `gateway-cloud-sync-v1` 的合并上传共用一个计划，避免账号合计与总量不一致。
- 上传失败不影响 `token_logs` 同步，下一轮重试；三张表的上传各自记录状态。

## 8. 发布与回滚

- 每个维度一条独立迁移与回归测试，接入 `supabase:verify:release`；负责人执行 `supabase db push`。
- 回滚：删除对应 RPC 与表；旧客户端不调用新 RPC，不受影响。桌面开关保持关闭即停止上传。
- Android 先探测 RPC 是否存在，缺失时把该维度标为「云端不支持」，不从其他字段推算。

## 9. 待负责人决定的问题

1. **账号名的隐私处理**：采用 3.2 的 A（哈希加用户确认的显示名）还是 B（白名单）？推荐 A，默认显示名留空。
2. **会话跨设备合并**：是否允许把 HMAC 密钥经现有设备同步通道共享，从而跨设备合并同一会话？推荐首版不合并。
3. **默认开关**：三个维度是否都默认关闭？推荐都默认关闭，在首次打开 Android 对应页时提示去桌面开启。
4. **会话行上限**：每设备每日 500 个会话是否足够？
5. **保留期**：是否与 `token_logs` 相同，还是会话与账号维度只保留最近 731 天？
6. **优先级**：三个维度是否按「会话 → 账号 → Context 构成」顺序分三次实施？
