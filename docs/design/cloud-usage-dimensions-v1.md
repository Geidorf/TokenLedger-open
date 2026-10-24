# 云端用量维度：会话、账号与平均 Context 构成（v1）

> **状态：已定，实施中。** 2026-10-24 负责人的决定见第 10 节，以下设计已按该决定收束；机器字段与 RPC 以 `docs/contracts/usage-dimensions-cloud-v1.md` 为准。适用平台：桌面（上传）、Supabase（存储与 RPC）、Android（只读）。

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

新表 `private.usage_session_days`，每用户每设备每会话每本地日一行：

| 列 | 含义 |
|---|---|
| `user_id` | 由写入 RPC 从 `auth.uid()` 确定的所有者 |
| `machine_id` | 与 `token_logs.machine_id` 相同的设备标识 |
| `session_key` | 不透明会话键：`HMAC-SHA256(本机随机密钥, 工具 + "\n" + 原始会话 ID)` 的前 16 字节十六进制。密钥只存本机安全存储，不经设备同步共享 |
| `tool` | 工具名 |
| `local_date` | 本地日期 `YYYY-MM-DD`（与 `token_logs.timestamp` 同一墙钟） |
| `tokens` | 当天该会话的有效 Token，即输入加输出，不再计入缓存读写 |
| `requests` | 当天该会话记录数 |
| `cost_usd` | 当天该会话预估费用，可空（不可得时为空，不写 0） |
| `first_at` / `last_at` | 当天该会话首末记录时间，截到分钟 |
| `top_model` | 当天有效 Token 最多的模型，可空 |
| `truncated` | 该设备当天是否超出 500 会话上限，同一设备日的所有行相同 |

- 缺少会话 ID（空、空白、`unknown_session`）的记录不进此表。截断和独立保留期都会使会话合计小于总量，Android 不通过两者相减推算缺少 ID 的用量。
- 跨日会话按日拆行；读取 RPC 按 `(machine_id, session_key)` 跨日合并，不跨设备合并。
- `get_usage_dimensions_v1(p_query jsonb)` 返回前 100 个会话与完整区间会话数；Android 首屏列出前 20 个并说明其余数量。会话键不用于展示原始会话标识。

### 3.2 账号（网关供应商，按日）

新表 `private.usage_provider_days`：`user_id`、`machine_id`、`local_date`、`provider`、`input_tokens`、`output_tokens`、`cached_tokens`、`cache_write_tokens`、`requests`、`cost_usd`。按日与白名单供应商聚合，不按工具、模型拆分。

- 只包含经 `dashboard-stats-v2` §2.5 去重后保留、且 `provider` 非空的网关与导入记录；扫描记录没有账号，不进此表。各账号合计可以小于 `token_logs` 总量，Android 必须写明「仅统计经网关的请求」。
- `provider` 只保留契约白名单中的规范名，其他值全部归为 `other`，Android 显示「其他」并说明多个账号可能合并。不上传用户自填标签、别名或标签哈希。
- 与另两个维度一起经 `get_usage_dimensions_v1` 读取；Android 展示有效 Token、请求数、缓存读写和可空费用。有效 Token 始终为输入加输出，费用未知不当作零。

### 3.3 平均 Context 构成（按日）

新表 `private.usage_context_days`：`user_id`、`machine_id`、`local_date`、`requests`、`prompt_tokens`、`system_bytes`、`tools_bytes`、`history_bytes`、`tool_results_bytes`、`attachments_bytes`、`messages`、`tool_results`、`attachments`，全部非负整数，含义与 §2.8 `contextComposition` 相同，只是按日求和。

- 只记大小与条数。日粒度足够算区间平均，且不暴露单次请求的大小分布。
- 读取 RPC 在区间内逐列求和，Android 用 `requests` 计算平均字节与平均输入 Token；没有行时返回明确的 `empty` 状态。
- 三个维度均区分 `ok`、`empty`、`filtered`。带模型或搜索筛选时三个维度均不可得；带工具筛选时账号与 Context 不可得。Android 不用未筛选的值填补。

## 4. 容量与上限

| 表 | 聚合粒度 | 上限 |
|---|---|---|
| `usage_session_days` | 每设备每日每会话一行 | 每设备每日最多 500 行，按有效 Token 取前 500 并标记 `truncated`；不改变总量 |
| `usage_provider_days` | 每设备每日每白名单供应商一行 | 15 个规范名及 `other`，名单外的账号合并 |
| `usage_context_days` | 每设备每日一行 | 无逐请求数据 |

- 三表统一保留最近 90 天。设备标识、工具与主模型最长 128 字符；会话键固定 32 个十六进制字符。
- 每个维度每批最多 92 个日期，整批最多 10000 行、JSON 文本不超过 2 MiB。具体日期范围及错误码见契约。
- 写入 RPC 在同一事务中替换本人、该设备、该日、该维度的全部行；空行集表示删除当日数据，重复上传结果相同，省略的维度不动。

## 5. 权限与 RLS

- 三张表都在 `private` schema，开启并强制 RLS。客户端没有直接表权限，所有读写和清理只经 RPC。
- RPC 使用 `SECURITY DEFINER`、空 `search_path`，所有者恒为 `auth.uid()`，查询校验复用 `private.tokenledger_normalize_query_v2`。客户端不持有 service role。
- 检查约束：计数与字节非负、`requests ≥ 1`、`first_at ≤ last_at`、键为 32 位十六进制。

## 6. 保留与删除

- 三个维度均保留最近 90 天；每次上传和每日清理删除过期行。删除云端账号时经 `on delete cascade` 删除该账号的维度记录；当前清理 RPC 以账号和维度为单位，不提供单设备清理接口。
- 关闭某个维度的开关：立即停止本机该维度的后续上传，再由 `clear_usage_dimension_v1()` 清理本人该维度全部设备的行；待清理、失败或未登录时保留标记。多个账号的标记分别保存，只有原账号登录且清理回执确认后才移除。
- 本机 HMAC 密钥丢失（重装）后，新旧 `session_key` 不再相同；旧行按保留期自然过期，不尝试迁移。

## 7. 上传节奏

- 手动或后台云同步成功后通知维度发布器；本地状态循环响应开关变化与失败重试。开启时补最近 90 天，此后重传今天、昨天及上传内容指纹变化的日。
- 网关维度复用本机看板的去重与聚合；去重前排除外机扫描和共享行。每日内容指纹覆盖费用、会话和 Context，历史修正与删除也会触发重传。
- 上传失败不影响 `token_logs` 同步；采用有上限的退避，旧云缺少 RPC 时五分钟后重试，三个维度分别记录状态。

## 8. 发布与回滚

- 三个维度放在一条迁移中，相关权限、输入约束、读取和清理回归接入 `supabase:verify:release`；负责人执行 `supabase db push`。
- 回滚：删除三个 RPC、定时清理任务与三张表；旧客户端不调用新 RPC，不受影响。桌面开关保持关闭即停止上传。
- Android 先探测 RPC 是否存在，缺失时把该维度标为「云端不支持」，不从其他字段推算。

## 9. 待负责人决定的问题

1. **账号名的隐私处理**：采用 3.2 的 A（哈希加用户确认的显示名）还是 B（白名单）？推荐 A，默认显示名留空。
2. **会话跨设备合并**：是否允许把 HMAC 密钥经现有设备同步通道共享，从而跨设备合并同一会话？推荐首版不合并。
3. **默认开关**：三个维度是否都默认关闭？推荐都默认关闭，在首次打开 Android 对应页时提示去桌面开启。
4. **会话行上限**：每设备每日 500 个会话是否足够？
5. **保留期**：是否与 `token_logs` 相同，还是会话与账号维度只保留最近 731 天？
6. **优先级**：三个维度是否按「会话 → 账号 → Context 构成」顺序分三次实施？

## 10. 负责人答复（2026-10-24）

1. 账号名采用 **B 白名单**：只上传内置供应商规范名，其余归为「其他」；不上传用户自填的标签，也不上传其哈希。
2. 会话不跨设备合并，HMAC 密钥只留在本机。
3. 三个维度都默认关闭。
4. 每设备每日 500 个会话的上限保留。
5. 云端只保留最近 **90 天**（三个维度相同），每次上传与每日定时清理删除过期行。
6. 三个维度一起实施；为减少实施轮次，账号与 Context 构成改为**按日**聚合（第 3.2 节原定按小时），云端不再按工具、模型拆分账号，带工具或模型筛选时 Android 标「筛选下不可得」。
