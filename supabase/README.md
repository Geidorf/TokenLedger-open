# TokenLedger Supabase 迁移链

本目录维护 TokenLedger 当前使用的 Supabase 云端 schema。迁移链是多智能体、多机器协作时的唯一事实来源；新环境必须通过 Supabase CLI 从头重放迁移，不再由各开发者手工拼接 SQL。根目录旧版 `SUPABASE_SETUP.sql` 已归档。

## 迁移清单

`supabase/migrations/` 共 23 条，按文件名顺序重放；下表是索引，细节见各节与迁移文件头注释。旧版“Schema vN”标题保留为历史章节名，不再代表当前版本。

| 迁移 | 内容 |
|---|---|
| `20260611033024_tokenledger_cloud_dashboard_mobile_prep` | 云端看板基线、物化视图与 `get_dashboard_stats` |
| `20260617111200_tokenledger_effective_tokens_headline_and_cache_split` | 有效 Token 主口径与缓存单列（v3） |
| `20260619120000_tokenledger_fix_per_tool_models_period_filter` | 工具卡片模型分布按周期统计（v3.1） |
| `20260714162044_tokenledger_stats_v2_details_comparison` | Stats v2：对比、明细筛选与专属看板（v4） |
| `20260715001948_dashboard_stats_v2_multi_filter_search` | 多选筛选与字面搜索（v5） |
| `20260715012217_quota_snapshot_sync` | owner-scoped 额度快照同步（v6） |
| `20260716093000_quota_codexbar_reason_codes` | CodexBar 原因码 |
| `20260717172408_durable_quota_snapshot_sync_v2` | 持久 latest-wins 额度同步（v7） |
| `20260723042753_dashboard_machine_distribution` | 设备分布 |
| `20260728021444_m10_release_security_hardening` | 公开 RC 安全收敛（v8） |
| `20260821130000_optimize_stats_v2_literal_search` | 字面搜索性能 |
| `20260901142623_preserve_stats_unknowns_and_cache_provenance` | 保留未知值与缓存来源 |
| `20260902090000_fix_stats_v2_date_buckets` | 日期分桶修复 |
| `20260903120000_restore_stats_v2_machine_distribution` | 恢复设备分布 |
| `20260903140000_quota_tombstone_and_tz_boundary_hardening` | 额度墓碑上限、时钟边界与刷新冷却 |
| `20260905162953_android_custom_date_ranges` | Android 自定义日期范围 |
| `20260906080642_add_dashboard_daily_costs` | 看板每日费用 |
| `20260909074317_entity_machine_token_components` | 专属看板设备 Token 构成 |
| `20261004120000_gateway_aggregate_provenance` | 网关合并聚合来源列 `gateway_requests` |
| `20261004140000_quota_currency_transport_v3` | 额度 transport v3（货币单位） |
| `20261004150000_quota_balance_reason_codes` | 供应商余额原因码 |
| `20261007045426_quota_active_capacity` | 墓碑重发时仍限 8 个活跃 Provider |
| `20261010170540_quota_recovery_metadata_and_write_guards` | 额度清空恢复元数据与写入防护 |

## 2026-10-10 额度清空恢复元数据与写入防护（T10.308）

迁移 `migrations/20261010170540_quota_recovery_metadata_and_write_guards.sql`：
- 重写 `upsert_quota_snapshots_v2`/`_v3`：来源 `observedAt` 超过服务器时钟 5 分钟时整批以 `quota_snapshot_invalid_payload` 拒绝，不再按服务器时间记录（取代下文 2026-09-03 一节的行为）；容量超限报 `capacity_exceeded`，失败统一经 `private.quota_snapshot_fail_v2` 抛出。
- 新增 `public.get_quota_snapshot_clear_metadata_v2()`，供客户端在清空后按 owner 恢复。
- 回归：`tests/quota_recovery_regression.sql`。

## 2026-10-07 额度活跃容量（T10.308b）

迁移 `migrations/20261007045426_quota_active_capacity.sql`：墓碑被重新发布时，活跃 Provider 仍不得超过 8 个；既有 generation/epoch 与旧观测保护优先。回归：`tests/quota_snapshot_capacity_regression.sql`。

## 2026-10-04 网关合并聚合的来源列（T10.273）

迁移 `migrations/20261004120000_gateway_aggregate_provenance.sql`：
- 桌面在本机按 `dashboard-stats-v2` §2.5 把网关记录与扫描日志合并去重后，再上传小时聚合；去重不在 RPC 里做，因为云端只有小时聚合、没有会话。
- `public.token_logs` 新增可空列 `gateway_requests`（该聚合行里来自网关的请求数，约束 `0 ≤ gateway_requests ≤ requests`）：新客户端写入，旧客户端不写即为 `null`。仅作来源审计，所有 RPC 签名、响应与 RLS 策略不变。
- 触发器 `token_logs_sync` 改为插入、更新、删除都标脏：合并上传可能只删除被网关取代的旧聚合行，物化视图也要刷新。
- 回归 `tests/gateway_aggregate_provenance_regression.sql`（已接入 `supabase:verify:release`）覆盖列与约束、旧客户端省略该列、同键 upsert 替换、跨用户 RLS、RPC 合计不变且不声明 `gatewayLedger`、只删不插也会标脏。
- 线上尚未部署。回滚：先停用新版桌面的合并上传，再 `alter table public.token_logs drop constraint token_logs_gateway_requests_range, drop column gateway_requests;` 并把触发器恢复为 `after insert or update`。

## 2026-09-03 额度上限、时钟边界与物化视图限流加固

迁移 `migrations/20260903140000_quota_tombstone_and_tz_boundary_hardening.sql`（T10.93 引入，T10.95 按 20260717 / 20260611 原函数体重写为最小改动）：
- `public.upsert_quota_snapshots_v2`：计算 8-Provider 上限时排除 `deleted_at is not null` 的墓碑（删满 8 个身份不再永久锁死账号）；来源 `observedAt` 超过服务器时钟 5 分钟时按服务器时间记录，防止时钟漂移的设备永久钉死 Provider（已被 2026-10-10 迁移改为整批拒绝）。参数名（`p_providers`）、reason code、返回载荷、`search_path` 与授权全部不变。
- `public.request_refresh()`：在原有 advisory 锁与 dirty/refreshed 代际判断之外增加 60 秒全局冷却（基于既有 `last_refreshed_at` 列），冷却期内返回 `reason = cooldown`、`stale = true`，仍通过 `refresh_token_logs_summaries()` 做 CONCURRENTLY 刷新。
- 墓碑**不做**年龄回收：上限修复已消除锁死，回收反而会给长期离线设备一个复活已删除 Provider 的窗口；`private.purge_expired_quota_snapshots_v1()` 保持 20260717 的空操作。

## v8 变更（公开 RC 安全收敛）

迁移 `migrations/20260728021444_m10_release_security_hardening.sql` 不改变 StatsData、Quota Provider 或任何公共 RPC 签名，只收敛 Supabase Advisor 已确认的问题：

- 为 `public.set_updated_at()`、`private.tokenledger_ascii_trim_v2(text)` 与 `private.tokenledger_search_match_v2(...)` 固定空 `search_path`。
- 删除会参与 SELECT 合并的冗余 `sync_state_modify_blocked` policy；没有写 policy 时 PostgreSQL 仍默认拒绝写入。
- 显式撤销 `anon/authenticated` 对 `sync_state` 的直接写权限，只保留 authenticated 只读；既有 SECURITY DEFINER 刷新/触发器路径不变。

`tests/release_readiness_regression.sql` 验证 public 表 RLS、`sync_state` 读写边界、三条 Advisor 修复、全部旧/新 RPC 签名与代表性 `EXPLAIN`。它与原有 Stats、Quota 回归共同执行，不能单独替代业务契约测试。

## 生产收敛状态（2026-07-28 只读盘点）

- 当时仓库是九条既有 migration 加一条 M10 hardening，共十条；连接的生产项目 migration history 只记录八条，既没有仓库 bootstrap，也没有本次 hardening，且其余八条的远端时间戳与仓库文件名不同。
- 只读 Advisor 盘点发现的三条 mutable `search_path` 和 `sync_state` 重复 permissive policy 已转为本地 migration；生产尚未应用，因此不能把本地文件存在视为线上已修复。Hosted Auth 的 leaked-password protection 也仍是外部配置项。
- 本轮没有执行生产备份、回滚演练、hardening 前后 Advisor 复核、migration history repair、`db push` 或任何生产写入。生产部署只能由唯一协调员在维护窗口内完成，并在发布清单中记录部署前后 migration head 与证据。

## v7 变更（持久 latest-wins 额度同步）

迁移 `migrations/20260717172408_durable_quota_snapshot_sync_v2.sql` 将 quota transport 升级为 v2：

- `get_quota_snapshots_v2()` 返回持久有效 Provider 与包含墓碑的 `providerStates`。
- `upsert_quota_snapshots_v2(integer,bigint,jsonb)` 按 `providerId + scope` 独立 upsert，缺项不删除；以窗口最大 `observedAt` 为主冲突时钟，相等时后收到者胜出，只接受 `ok/stale` LKG。
- `delete_quota_snapshot_provider_v2(...)` 推进单 Provider generation 并写墓碑；`clear_quota_snapshots_v2(integer,bigint)` 推进全局 epoch 与全部现有 generation。
- 快照不再按年龄过期，旧 purge cron 已取消；旧 v1 get 读取持久有效行，旧 replace 降级为 additive latest-wins，旧 clear 仍作为显式全局删除兼容。

表继续位于 `private` schema 并强制 RLS；客户端没有表权限。四个 v2 `SECURITY DEFINER` RPC 固定空 `search_path`、只向 `authenticated` 授予 EXECUTE，并从 `public/anon/service_role` 撤销。`tests/quota_snapshot_v2_regression.sql` 在事务中覆盖双用户隔离、缺项保留、旧/相同来源时间、错误 envelope、Provider/全局墓碑、迟到写和十年旧数据读取。本次只验证本地 Supabase PG17，尚未部署远程项目。

### transport v3（门控货币单位，T10.284）

迁移 `migrations/20261004140000_quota_currency_transport_v3.sql` 新增 `get_quota_snapshots_v3()` 与 `upsert_quota_snapshots_v3(integer,bigint,jsonb)`，与 v2 共用同一批行、epoch、revision、generation 与墓碑；单 Provider 删除和全局清除继续用 v2 函数。v3 写入额外接受 `unit='currency'` 与 ISO 4217 大写三字母 `currency`（缺码、小写、非三字母、出现在其他单位、带 `windowMinutes/resetsAt` 均拒绝），其余不变量复用 v1/v2 校验。

旧读取方永远收不到新单位：所有 v2 响应（get/upsert/delete/clear）与 v1 get 在服务端投影中省略含货币窗口的 envelope，v2 响应同时省略其 `providerStates` 条目（已发布客户端要求每个活跃状态都有对应 envelope，否则整条响应失败），旧端表现为「该来源未同步」；v1/v2 写入继续拒绝货币窗口。迁移重申两表 RLS 与表权限撤销，两个 v3 RPC 只授予 `authenticated`。**线上须先执行本迁移再发布新桌面**；新桌面与新 Android 在 v3 返回 `PGRST202`/404 时回退 v2。`tests/quota_snapshot_v3_regression.sql` 覆盖 v3 读写、v2/v1 投影省略、v2/v1 写拒绝、v3 拒绝错误 transport 与非法货币窗口、删除墓碑、双用户隔离、权限与 `EXPLAIN`。

### 供应商余额原因码（T10.288）

迁移 `migrations/20261004150000_quota_balance_reason_codes.sql` 只替换 `private.quota_snapshot_reason_valid_v1`，在白名单末尾追加 `balance_unavailable`、`api_key_required`、`secure_storage_unavailable`：余额来源（`balance-*`）经 v3 上传，读取失败时的历史快照会带这三种原因，此前服务端会把整批上传拒为 `invalid_payload`。v1/v2 校验与 v2/v1 投影不变，货币快照仍不出现在 v2/v1 读取中；RLS 与权限照旧重申。**线上须先执行本迁移再发布能上传余额的新桌面**。`tests/quota_balance_reason_regression.sql`（需 `balance_fixture`）覆盖三种原因的 v3 写入、未登记原因拒绝、v2 投影省略与 v2 写拒绝、函数权限与 RLS，已接入 `supabase:verify:release`。

## v6 变更（owner-scoped 额度快照同步）

迁移 `migrations/20260715012217_quota_snapshot_sync.sql` 由 `supabase migration new quota_snapshot_sync` 分配编号，在 Stats 数据链之外增加独立的 Quota Provider v1 同步层：

- `replace_quota_snapshots_v1(integer, bigint, jsonb)`：锁定当前认证用户的 state，仅在 epoch 匹配时原子替换完整 Provider 集合并提升 revision。
- `get_quota_snapshots_v1()`：只返回当前用户、未过期且通过 v1 严格校验的 envelope 投影，不返回用户 ID、内部行标识或 TTL 字段。
- `clear_quota_snapshots_v1(integer)`：锁定 state、删除当前用户全部快照，并同时提升 epoch/revision，使迟到 replace 必然以 `quota_snapshot_stale_epoch` 失败。

状态与 envelope 分别保存在 `private.quota_snapshot_state`、`private.quota_snapshots`。两表均启用并强制 RLS，但客户端没有 schema/table 权限和写策略；三个 `SECURITY DEFINER` RPC 固定空 `search_path`、完全限定对象名，且只向 `authenticated` 授予 EXECUTE，`public`、`anon` 与 `service_role` 均显式撤销。额度消费者产品不使用 service-role 绕过用户授权路径。

服务端按 `quota-provider-v1` 对字段、枚举、reason code、稳定键、RFC 3339 时间、有限数、状态归并及 percent/Credits 不变量 fail closed；单次最多 8 个 Provider、每个最多 16 个 window、稳定 ID 最多 128 UTF-8 bytes、其他字符串最多 512 bytes。生产者仍须在紧凑 JSON 达到 60 KiB 前拒绝，数据库以 `p_providers::text` 的 64 KiB 为权威上限，任何失败都不产生部分写入。

快照行固定 `expires_at = updated_at + 24 hours`；读取会物理删除调用者的过期行，名为 `tokenledger-quota-snapshot-hourly-purge` 的 `pg_cron` 作业每小时清理不活跃账户，因而总物理保留不超过 25 小时。本次只完成本地 PG17 迁移、权限和 fixture 回归，未连接或部署远程 Supabase 项目；线上调度器和真实账户仍需外部验收。

## v5 变更（canonical 多选与字面搜索）

迁移 `migrations/20260715001948_dashboard_stats_v2_multi_filter_search.sql` 由 `supabase migration new dashboard_stats_v2_multi_filter_search` 分配编号，新增四个明确命名且不重载旧入口的 RPC：

- `get_dashboard_stats_v2(p_user uuid, p_query jsonb)`
- `get_usage_comparison_v2(p_user uuid, p_query jsonb)`
- `get_usage_details_v2(p_user uuid, p_query jsonb, p_cursor text default null, p_limit integer default 50)`
- `get_usage_entity_dashboard_v2(p_user uuid, p_query jsonb, p_entity jsonb, p_cursor text default null, p_limit integer default 20)`

四条链路共同接受 `range + timezone + machines[] + tools[] + models[] + search + tokenMode`。数组同维 OR、跨维 AND；空数组不限制。服务端只 trim TAB/LF/CR/SPACE，按 unsigned UTF-8 bytes 精确去重排序，拒绝空元素、错误类型、超过 32 项、单项超过 256 bytes、plural/singular 冲突和 plural machine 哨兵。旧 `machine/tool/model` 只作为兼容输入；canonical echo 总是包含 plural，0/1 项额外产生等价 singular echo。

`search` 只覆盖 `tool/model/machine_id/session_id`：纯 ASCII 查询只折叠 ASCII 大小写，含非 ASCII 时保持大小写敏感；`%`、`_` 和反斜线通过 `strpos` 按字面值匹配。明细 facet 仅排除自身维度，v2 keyset 游标绑定 canonical query；实体游标再绑定规范化后的 `entity.kind + entity.id`。四条 v2 响应只有在整条事实链同时可用时才显式返回 `meta.capabilities.multiFilterSearch=true`。旧 `get_dashboard_stats` 与三个 `_v1` RPC 保持原签名和权限，不部署 v2 时客户端只能按契约 fallback matrix 做无损降级。

该迁移仍使用 `auth.uid() = p_user`、空 `search_path` 的 `SECURITY DEFINER`、private helper 无 USAGE/EXECUTE、以及 authenticated/service_role 的显式 EXECUTE grant。本次只完成本地迁移与回归，未连接或部署远程项目。

## v4 变更（统计对比、明细筛选与专属看板）

迁移 `migrations/20260714162044_tokenledger_stats_v2_details_comparison.sql` 增加三条保持旧客户端兼容的新 RPC：

- `get_usage_details_v1`：按周期、设备、工具与模型组合筛选，使用 `(timestamp DESC, id DESC)` keyset 游标，返回自维度可切换的 facet、筛选后汇总与分页明细。
- `get_usage_comparison_v1`：今日对昨日、本周对上周、本月对上月的同进度比较；月末按两个自然月都存在的日序截断，基期为 0 时返回 `percent = null` 与 `direction = new`。
- `get_usage_entity_dashboard_v1`：模型或工具的专属汇总、同期趋势、构成、活跃度、峰值、热力图与首屏明细。

同时补齐 2026 Data API 的显式表/序列授权、优化 RLS 中的 `auth.uid()` 调用、收紧内部 helper schema 与函数执行权限，并为明细 keyset 路径增加组合索引。云端 `token_logs.timestamp` 仍是无 offset 的本地 wall-clock 文本；跨时区无损回看需要后续数据迁移，本版本不会伪造精度。

## v3.1 修复（工具卡片模型分布按统计周期统计；历史记录，现行部署只走迁移链）

修复了 `get_dashboard_stats` 中**单个工具的 `models` 模型明细未按所选统计周期过滤**的问题：此前每个工具的模型分布是「全部历史」聚合，而工具行的 `total`（以及卡片头部的当日/本周等总量）是按周期聚合的，导致工具详情卡片里模型数值远超工具总量、占比出现 32112% 这类异常值。两条代码路径都已修正：

- **Path A（按设备，base 表 `token_logs`）**：模型子查询补充 `(immutable_date_parse(timestamp)) >= v_start_date`。
- **Path B（跨设备，物化视图 `token_logs_daily_by_model`）**：模型子查询补充 `date >= v_start_date`。
- 工具/模型的 `heatmap` 子聚合**仍保持全历史**（热力图需要展示完整历史），本次不改动。
- 当时的升级方式（历史记录）：执行迁移 `migrations/20260619120000_tokenledger_fix_per_tool_models_period_filter.sql`（仅以 `create or replace` 重建 `get_dashboard_stats`，无需重建物化视图）。客户端（桌面端 / Android）无需改动。

## v3 变更（应用 1.2.0；历史记录，现行部署只走迁移链）

应用 1.2.0 调整了 Token 统计口径。当时的做法是重新执行 `schema.sql`；**现在不要这样做**，按迁移链顺序应用对应迁移即可得到同样结果（`schema.sql` 是禁止执行的历史快照）。该版本的口径变化：

- **`token_logs` 新增 `cache_write_tokens` 列**：`cached_tokens` 保留「缓存读+写」合计，`cache_write_tokens` 单独记录写入份额，供成本估算按读价（0.1×）/写价（1.25×）分别计价。脚本通过 `add column if not exists` 自动补列，1.2.0 之前的客户端写入时省略该字段即可，向后兼容。
- **`total_tokens` 口径改为「有效 Token」= 输入 + 输出**：所有物化视图与 RPC 不再把缓存量计入 `total_tokens`，避免缓存量把总量放大几十倍、并让缓存密集的工具在图表里压垮其他工具。缓存通过 `cachedTokens` / `cacheReadTokens` / `cacheWriteTokens` 单独返回。
- **RPC `summary` 与 `tools` 新增 `cacheReadTokens` / `cacheWriteTokens` 字段**，`history` 行新增 `cacheWriteTokens`。桌面端与 Android 端均向后兼容旧版 RPC（字段缺失时回退为 0，并在客户端以「输入+输出」重算有效 Token）。
- 桌面端首次启动 1.2.0 时会用本机 hostname 对云端 `tool='claude'` 的旧聚合行做一次性清理（修复历史上 Claude 按内容块重复计数的问题），随后按修正口径重新推送，无需手动操作。

## 当前交付文件

- `migrations/`：当前部署的唯一事实来源；迁移编号由项目协调员单写。
- `migrations/20260611033024_tokenledger_cloud_dashboard_mobile_prep.sql`：可从空库重放的基础 schema；已修复旧链路缺少 `cache_write_tokens` 的 bootstrap 断点。
- `migrations/20260714162044_tokenledger_stats_v2_details_comparison.sql`：v4 统计能力、权限与索引。
- `migrations/20260715001948_dashboard_stats_v2_multi_filter_search.sql`：v5 canonical query、多选、字面搜索、query/entity-bound cursor 与四条 v2 RPC。
- `migrations/20260715012217_quota_snapshot_sync.sql`：v6 owner-scoped 额度快照、epoch/revision 竞态、严格投影校验、24h TTL 与小时级清理。
- `migrations/20260717172408_durable_quota_snapshot_sync_v2.sql`：v7 持久 per-Provider latest-wins、generation/epoch 墓碑与 v1 兼容。
- `migrations/20260728021444_m10_release_security_hardening.sql`：v8 固定函数 `search_path` 并收窄 `sync_state` 直接权限，不改变公共签名。
- `migrations/20260906080642_add_dashboard_daily_costs.sql`：在公开 Stats v2 主看板的 canonical 过滤集合中一次聚日，追加可选 `dailyCosts` 预估金额；不改变旧必填成本、热力图、缓存来源或 RPC 权限语义。
- `migrations/20261004120000_gateway_aggregate_provenance.sql`：`token_logs.gateway_requests` 来源列与范围约束，`token_logs_sync` 触发器覆盖删除；RPC 不变（T10.273）。
- `migrations/20261004140000_quota_currency_transport_v3.sql`：额度 transport v3 两个 RPC、门控货币单位校验，v2/v1 读取投影省略含货币的 envelope（T10.284）。
- `migrations/20261004150000_quota_balance_reason_codes.sql`：额度原因码白名单追加余额来源的三个原因码，投影与权限不变（T10.288）。
- `tests/stats_v2_regression.sql`：事务内构造双用户与 10 万行样本，验证 RLS、显式权限、旧 RPC、canonical query、OR/AND、facet、字面搜索、游标、同进度比较、实体身份与执行计划。
- `tests/custom_date_range_regression.sql`：除 custom 日期边界、DST 与跨年外，验证 `dailyCosts` 的当地日键、可信空集、未来截止和排序；T10.122 起已接入 `npm run check` 的 Supabase 回归步骤与 `supabase:verify:release`，不再需要单独执行。
- `tests/quota_snapshot_regression.sql`：v6 历史语义回归；检测到 transport v2 时主动跳过，不作为当前数据库门禁。
- `tests/quota_snapshot_v2_regression.sql`：验证持久保留、A/B 缺项不互删、来源时间 latest-wins、同时间接收裁决、墓碑/epoch、RLS/RPC 与旧数据读取。
- `tests/quota_snapshot_v3_regression.sql`：验证 v3 货币读写、v2/v1 投影省略与写拒绝、非法货币窗口、删除墓碑、双用户隔离、权限与 `EXPLAIN`。
- `tests/quota_balance_reason_regression.sql`：验证余额原因码的 v3 写入、未登记原因拒绝、v2 投影省略、函数权限与 RLS（只在 `supabase:verify:release` 中执行）。
- `tests/release_readiness_regression.sql`：验证 RC 所需的 RLS、权限、Advisor 修复、兼容签名和执行计划。
- `tests/gateway_aggregate_provenance_regression.sql`：网关合并聚合的来源列、旧客户端兼容、RLS、RPC 合计与删除标脏。
- `schema.sql`：仅保留为 v3.1 基线/灾难恢复资料；它不是当前部署入口，常规部署、多人协作和 CI 均不得以它替代迁移链。

## 本地验证

发布 SQL 门禁必须绑定已经由协调员准备并启动的专用本地项目，不会自动创建、启动或停止服务。不得在用户的 `tokenledger` 项目上运行重置。三个参数均必填：

```bash
# 先准备仓库外专用目录：普通文件复制当前 supabase/migrations；不复制 .env、.temp 或用户数据。
# 专用 config.toml：project_id 与下方 PROJECT 相同；PG17；独立端口（不得用54320–54329）；
# [db.migrations] enabled=true、schema_paths=[]；[db.seed] enabled=false。
# 按项目自己的 --workdir 启动并检查容器/卷标签；CLI固定2.109.1，须提前安装或已有离线缓存。
export TOKENLEDGER_SUPABASE_GATE_WORKDIR=/tmp/tokenledger-t10308-sql-20261011
export TOKENLEDGER_SUPABASE_GATE_PROJECT=tokenledger-t10308-sql-20261011
export TOKENLEDGER_SUPABASE_GATE_CONTAINER="$(docker inspect --format '{{.Id}}' "supabase_db_${TOKENLEDGER_SUPABASE_GATE_PROJECT}")"
npm run supabase:verify:release
```

项目 ID 必须采用 `tokenledger-t<任务标识>-sql-<本次标识>`，并与配置、准确容器名、两个项目标签、数据库配置及实际映射端口和独有数据卷一致。容器必须运行官方 `supabase/postgres` 的 PG17 镜像，只能挂载该项目独有的数据卷；额外挂载一律拒绝。目录先取 realpath（macOS `/tmp` 可正常使用），须位于仓库外且不在任何 Git checkout 内；配置和迁移路径不得是符号链接，TOML 安全字段只接受无歧义的普通键/表，拒绝重复、带引号的键/表及多行字符串。reset 前逐文件核对迁移清单与 SHA-256，必须与当前候选完全一致；任何前置错误都在重置与 SQL 执行前失败。缺少全局 CLI 时只尝试已有固定版本的离线 npm 缓存，不隐式安装或升级。

设置容器 ID 不会跳过 fresh reset。所有 CLI 调用均显式传入专用 `--workdir`，重置带 `--local --no-seed`；重建后只解析该项目准确名称、重新验证归属并绑定新完整 ID，不自动寻找其他数据库。运行期间冻结专用配置、迁移目录与项目生命周期，不让其他进程同时重命名/重建该项目；本机同权限进程的恶意竞态不在这些检查的防护范围内。验证完成后由协调员按已登记项目处理服务与备份，不能使用 `stop --all` 或删除用户卷。

数据卷还必须使用标准本地后端：`Driver=local`、`Scope=local`、`Options=null` 或空对象，卷 `Mountpoint` 与容器 `Source` 均为 `/var/lib/docker/volumes/<专用容器名>/_data`。仅有专用名称及标签不足以证明隔离；bind/NFS/自定义驱动别名均拒绝。非标准 Docker data-root/rootless 路径会保守拒绝，不保证所有 Docker 环境可用；不得为了通过门禁改指用户数据卷。

`dailyCosts` 是 `get_dashboard_stats_v2(uuid,jsonb)` 的可选扩展。`coverage` 回显 canonical 范围、有效 IANA 时区与实际截止当地日；`days` 只包含有效 Token 大于零的活跃日。当天所有匹配行（包括零有效 Token 行）都参与成本完整性判断：缺失成本、非法/负数/非有限或累计超出 float8 上界、历史零成本分别返回不可用原因，只有全部成本严格正且有限时才以 numeric 累加后输出 `recorded-estimate`。`complete` 只表示本次数据库窗口完整执行，不代表扫描和同步历史绝无漏项。

此可选扩展以前述旧核心成功生成有效响应为前提。历史必填总成本、工具成本等仍使用原有 float8 聚合；旧必填聚合溢出或核心非法时，沿用整条请求失败及客户端既有错误恢复，不承诺 dailyCosts 返回，不用零值或钳位掩盖失败。同工具两笔 1e308 会触发旧成本聚合的溢出边界，不能把日金额 numeric 保护当作整条 RPC 的成功保证。

迁移保留 `auth.uid() = p_user`、`SECURITY DEFINER`、空 `search_path`、旧签名与既有授权。溢出回归先调用未替换任何函数的真实公开 wrapper，针对上述两行断言预期的数值越界错误（SQLSTATE 22003，须在隔离容器实际运行核实）；随后才在事务内保存并临时替换 private base，以最小合法旧响应单测日金额 numeric 上界保护，成功和异常路径均恢复原定义。两项运行证据必须分列：真实 RPC 预期失败，以及分支隔离分类；后者不代表生产 RPC 成功。该隔离只属于测试，不新增产品 helper，也不改变最终数据库对象。

精确时刻截止回归使用同一当地今日的已发生记录和晚于 transaction now 的唯一未来记录，先断言夹具确实晚于 now 且同日，再通过真实 today 和 custom 未来 end 请求校验旧 summary 与日金额都排除未来记录。仅 coverage.end 等于今日不能证明精确时刻截止正确；未实际执行 SQL 时只能标记测试已编写、运行待验证。

多人共用 Docker 时同样使用上述显式隔离入口，禁止自动探测任一 `supabase_db_` 数据库。历史 T10.118b 的一次性 PostgreSQL 替代环境不等于本入口完整 Supabase fresh replay；替代验证须单独记录。容器名、完整 ID、资源上限、实际计划与响应字节数记录在任务日志，验证结束后只处理本任务资源。SQL运行及advisors未执行时应写待验证，不能用静态检查代替。

`supabase:verify:release` 会再次执行专用项目 fresh `db reset`，核对本地 migration history 与仓库全部迁移逐条一致，再完整运行十组 SQL：统计、日期边界、实体/机器 Token 分量、额度 v2/v3、清空恢复、活跃容量、余额原因码、网关来源与发布权限，以及严格 schema lint。以下仅展示单项排查方式，不能代替完整发布门禁；`GATE_DB_ID` 应取重建后已核验的专用完整 ID：

```bash
docker exec -i "$GATE_DB_ID" psql -v ON_ERROR_STOP=1 -U postgres -d postgres \
  < supabase/tests/stats_v2_regression.sql
docker exec -i "$GATE_DB_ID" psql -v ON_ERROR_STOP=1 \
  -U postgres -d postgres \
  < supabase/tests/custom_date_range_regression.sql
docker exec -i "$GATE_DB_ID" psql -v ON_ERROR_STOP=1 \
  -U postgres -d postgres \
  -v transport_v2_fixture="$(jq -c . fixtures/quota-provider-v1/transport-v2.json)" \
  < supabase/tests/quota_snapshot_v2_regression.sql
docker exec -i "$GATE_DB_ID" psql -v ON_ERROR_STOP=1 \
  -U postgres -d postgres \
  -v transport_v3_fixture="$(jq -c . fixtures/quota-provider-v1/transport-v3.json)" \
  -v currency_fixture="$(jq -c . fixtures/quota-provider-v1/currency-v1.json)" \
  < supabase/tests/quota_snapshot_v3_regression.sql
docker exec -i "$GATE_DB_ID" psql -v ON_ERROR_STOP=1 \
  -U postgres -d postgres \
  -v balance_fixture="$(jq -c . fixtures/quota-provider-v1/balance-v1.json)" \
  < supabase/tests/quota_balance_reason_regression.sql
docker exec -i "$GATE_DB_ID" psql -v ON_ERROR_STOP=1 \
  -U postgres -d postgres \
  < supabase/tests/release_readiness_regression.sql
npx --offline --no supabase@2.109.1 --workdir "$TOKENLEDGER_SUPABASE_GATE_WORKDIR" db lint --local \
  --schema public,private --level warning --fail-on warning
```

`db reset` 必须能从空库顺序执行 `migrations/` 下的全部迁移（不要在文档里硬编码条数，以目录为准）。回归 SQL 使用 `BEGIN/ROLLBACK`，不会保留测试账号或消耗记录。生产环境部署不包含在本地验证命令中，必须单独走变更审查、备份、回滚演练和维护窗口。

### 自动化门禁（T7.2）

`npm run check`（`scripts/run-checks.mjs`）新增「Supabase SQL regression」步骤：通过 `docker ps` 检测名称以 `supabase_db_` 开头的本地容器。可用 `SUPABASE_TEST_CONTAINER=容器名 npm run check` 显式绑定隔离测试库；指定库未运行、Docker 无法确认指定库或发现多个候选却未指定时直接失败，绝不回退到另一个库。只有单个候选时才自动选择，命中则对上面四条回归 SQL（`stats_v2_regression.sql`、`custom_date_range_regression.sql`、`quota_snapshot_v2_regression.sql`、`quota_snapshot_v3_regression.sql`）依次执行 `psql -v ON_ERROR_STOP=1`，任一失败即整条 `check` 失败；未检测到本地容器（含 docker 不可用）时只打印黄色 `SKIP` 警告并放行，**不能替代本文档描述的手工回归**——契约类改动合入前仍必须按上方命令手工跑一遍。`quota_snapshot_regression.sql`（v6 历史语义回归）不在自动化门禁范围内，原因同上文：它检测到 transport v2 时会主动跳过，且不在本节命令列表内。

`npm run check:release` 使用独立的严格编排器，覆盖文档、前端、扫描规模、Rust fmt/test/`clippy -D warnings`、Android unit/Lint/截图/Debug/无签名 R8 与本节完整 Supabase fresh replay。与开发期 `npm run check` 不同，发布门禁缺少 Docker、固定版本 CLI 或数据库容器时直接失败，不允许跳过。`npm run release:bump` 本身不做前置检查链，仍只负责协调员显式版本提升。

若本机 Studio 镜像自身损坏，可使用 `npx supabase start --exclude studio` 启动其余本地服务，但仍须通过 `supabase status` 和数据库查询确认 PostgreSQL 与 `pg_cron` 健康；排除 Studio 只是有界的本地环境 workaround，不能替代 fresh `db reset`、SQL 回归或远程调度器验收。

若共享 Docker Desktop 无法维持 Supabase 全栈健康检查，可在不清理任何既有 volume/image 的前提下，用隔离的临时 PostgreSQL 17 容器顺序重放 `migrations/*.sql`，再通过 `--db-url ...?sslmode=disable` 执行 lint；任务日志必须同时记录 Supabase CLI 的原始失败签名与替代环境，不能把临时容器冒充完整本地 Supabase 验收。

## 这个 schema 做了什么

v2 schema 在 `token_logs` 上增加服务端聚合能力：

- 4 个看板物化视图：按天/工具、按天/模型、按工具、按模型聚合，避免客户端拉取大量明细再计算。
- 1 个年度热力图物化视图：按 `(user_id, date)` 聚合。
- 2 个受认证 RPC：
  - `get_dashboard_stats(p_user, p_range, p_machine, p_timezone)`：返回桌面端和 Android 看板需要的 JSON。
  - `get_yesterday_stats(p_user, p_machine, p_timezone)`：返回壁纸昨日对比所需的聚合数据。
- 1 条延迟刷新链路：写入 `token_logs` 后递增 `sync_state.dirty_generation`，由桌面端同步后调用 `request_refresh()` 刷新物化视图。
- 1 个时间戳安全解析函数：异常 `timestamp` 会被解析为 `null`，避免刷新物化视图时整批失败。
- 1 个 `NOT VALID` 时间戳格式约束：约束新数据形状，同时不阻断旧数据迁移。

旧版 `get_cloud_stats` 曾经分页读取 `/token_logs` 明细并在 Rust 端聚合。v2 改为 Postgres 服务端聚合，通常只返回几 KB JSON，显著减少网络传输和客户端计算。

## 性能预估

以下是基于 10 万行样本数据和约 50 ms Postgres 往返延迟的理论估计：

| 路径 | 冷启动 | 缓存命中 |
| --- | --- | --- |
| 旧版 `get_cloud_stats`：分页读取明细 | 约 8 秒 | 不适用 |
| 新版 `get_dashboard_stats`：物化视图 | 约 0.5 秒 | 约 0.4 秒 |
| 新版 RPC + 5 分钟本地缓存 | 约 0.5 秒 | 约 5 ms |

v5 回归在 PostgreSQL 17.6、100,010 条事务内样本上得到：完全限定的设备+工具+模型 keyset 查询使用 `token_logs_user_machine_tool_model_time_id_idx` 的 Index Only Scan，重复执行约 `0.054–0.063 ms`；带字面 search 的用户/时间索引扫描约 `364–498 ms`。后者仍需检查候选行文本，当前低于 1.2 秒目标，但真实云实例、冷缓存和网络时延仍待外部验收。

首次部署或大量写入后，`REFRESH MATERIALIZED VIEW CONCURRENTLY` 需要重算视图，可能比普通查询更慢。

## 部署步骤

1. 在受控环境完成数据库备份，并确认目标项目引用无误。
2. 使用 Supabase CLI 查看待执行迁移并完成审查，再通过标准 migration workflow 部署。
3. 常规部署只允许迁移链；禁止让普通用户在 SQL Editor 执行 `schema.sql`。只有经审批的灾难恢复流程才可使用基线资料，并必须随后校准完整 migration history。
4. 灾难恢复基线脚本可重复执行：
   - `create ... if not exists` 保证新项目可直接初始化。
   - `alter table ... add column if not exists` 会升级旧项目的列。
   - 聚合物化视图会被重建，确保新统计口径生效。
5. 基线脚本末尾的 `do $$ ... $$` 会执行一次 `refresh_token_logs_summaries()`，让视图在部署后立即可用。

注意：`get_dashboard_stats` 和 `get_yesterday_stats` 必须在认证用户上下文中调用。SQL Editor 直接调用时没有 `auth.uid()`，被拒绝是预期行为。

如果客户端报错 `Could not find the function ... in the schema cache`，说明 Data API 还没有看到对应函数签名。通常是线上项目尚未执行本目录 SQL，或执行后 PostgREST schema cache 尚未刷新。先确认 `get_dashboard_stats(uuid, text, text, text)` 和 `get_yesterday_stats(uuid, text, text)` 已存在，再重新刷新客户端。

## 安全模型

- `token_logs` 启用 RLS，用户只能读写自己的行。
- 聚合物化视图不继承 `token_logs` 的 RLS，因此不会授权给 `anon` 或 `authenticated` 直接读取。
- 客户端只能通过受检查的 RPC 读取聚合数据。
- RPC 内部要求 `auth.uid() = p_user`，匿名请求或查询其他用户都会被拒绝。
- `SECURITY DEFINER` 统计函数显式设置空 `search_path`，并对所有对象使用 schema-qualified 名称，降低对象劫持风险。
- Quota 快照位于未暴露的 `private` schema；两表无客户端 grant/写策略，三个 owner-scoped RPC 只允许 `authenticated` 执行，并在锁定 state 后完成 replace/get/clear。
- Quota 同步只持久化严格白名单 envelope；`action`、`accountLabel`、未知字段、凭据、Cookie、session、原始来源和本地路径均无法进入云端投影。
- 客户端只应使用 Supabase URL 和 publishable key；不要在桌面端、APK 或仓库中放入 service role 或 secret key。

## 刷新一致性

`sync_state` 使用 generation 管理刷新状态：

- `dirty_generation`：每次 `token_logs` 写入后递增。
- `refreshed_generation`：最近一次物化视图刷新覆盖到的 generation。
- `is_dirty`：兼容旧逻辑的布尔标记，由 generation 差值推导。

`request_refresh()` 使用固定 bigint advisory transaction lock 串行刷新。刷新过程中如果有新写入，`dirty_generation` 会继续前进，刷新结束后仍保持 stale，下一次刷新会补齐。

## RPC 返回形状

`StatsData` 兼容既有字段，并追加可选 `meta`：

```json
{
  "meta": {
    "generatedAt": "...",
    "lastRefreshedAt": "...",
    "timezone": "Asia/Shanghai",
    "range": "today",
    "machine": null,
    "stale": false
  }
}
```

桌面端和 Android 会传入 IANA timezone，例如 `Asia/Shanghai`。数据库会按该时区计算今日、本周、本月和今年边界；非法时区会回退到 `UTC`。

## 数据库对象

| 对象 | 类型 | 用途 |
| --- | --- | --- |
| `public.token_logs` | 表 | 云端 Token 日志记录 |
| `public.sync_state` | 表 | 记录物化视图刷新 generation |
| `token_logs_user_time_idx` | 索引 | 用户维度时间查询 |
| `token_logs_user_machine_idx` | 索引 | 用户 + 设备筛选 |
| `token_logs_user_tool_idx` | 索引 | 用户 + 工具筛选 |
| `token_logs_user_date_tool_idx` | 索引 | 日期和工具聚合 |
| `token_logs_user_tool_model_idx` | 索引 | 工具和模型聚合 |
| `token_logs_date_idx` | 索引 | 跨用户日期扫描或管理查询 |
| `public.token_logs_daily_by_tool` | 物化视图 | 趋势和每日工具聚合 |
| `public.token_logs_daily_by_model` | 物化视图 | 每日模型聚合 |
| `public.token_logs_by_tool` | 物化视图 | 工具汇总 |
| `public.token_logs_by_model` | 物化视图 | 模型汇总 |
| `public.token_logs_year_heatmap` | 物化视图 | 年度热力图 |
| `set_updated_at` | 触发器函数 | 维护 `updated_at` |
| `sync_token_log` | 触发器函数 | 递增 `dirty_generation` |
| `token_logs_set_updated_at` | 触发器 | 更新行时写入 `updated_at` |
| `token_logs_sync` | 触发器 | 写入后标记刷新状态 |
| `refresh_token_logs_summaries()` | 函数 | 刷新全部 5 个物化视图 |
| `request_refresh()` | RPC 函数 | 桌面端触发刷新 |
| `get_dashboard_stats(p,u,m,tz)` | RPC 函数 | 看板聚合数据 |
| `get_yesterday_stats(p,m,tz)` | RPC 函数 | 昨日壁纸聚合数据 |
| `get_usage_details_v1(...)` | RPC 函数 | 组合筛选与 keyset 明细 |
| `get_usage_comparison_v1(...)` | RPC 函数 | 日/周/月同进度趋势对比 |
| `get_usage_entity_dashboard_v1(...)` | RPC 函数 | 工具/模型专属看板 |
| `get_dashboard_stats_v2(uuid,jsonb)` | RPC 函数 | canonical 多选/搜索主看板 |
| `get_usage_comparison_v2(uuid,jsonb)` | RPC 函数 | canonical 多选/搜索同进度比较 |
| `get_usage_details_v2(uuid,jsonb,text,integer)` | RPC 函数 | canonical 多选/搜索与 query-bound keyset 明细 |
| `get_usage_entity_dashboard_v2(uuid,jsonb,jsonb,text,integer)` | RPC 函数 | selector 分离且 entity-bound 的专属看板 |
| `private.tokenledger_usage_summary_v1(...)` | 内部函数 | 同一口径的筛选汇总 |
| `private.tokenledger_usage_series_v1(...)` | 内部函数 | 当前/上一周期稠密序列 |
| `private.quota_snapshot_state` | 表 | 每用户单调 epoch/revision 与行锁入口 |
| `private.quota_snapshots` | 表 | 持久 owner-scoped Provider envelope、来源时间、generation 与墓碑 |
| `replace_quota_snapshots_v1(integer,bigint,jsonb)` | RPC 函数 | 旧客户端 additive latest-wins 兼容写 |
| `get_quota_snapshots_v1()` | RPC 函数 | 旧客户端读取持久有效额度 |
| `clear_quota_snapshots_v1(integer)` | RPC 函数 | 旧客户端显式全局删除并提升 epoch/revision |
| `private.purge_expired_quota_snapshots_v1()` | 内部函数 | v7 兼容 no-op，固定返回 0 |
| `get_quota_snapshots_v2()` | RPC 函数 | 读取持久有效 Provider 与全部 Provider generation 状态 |
| `upsert_quota_snapshots_v2(integer,bigint,jsonb)` | RPC 函数 | 按来源观测时间条件 upsert，缺项不删除 |
| `delete_quota_snapshot_provider_v2(integer,bigint,text,text,bigint)` | RPC 函数 | 显式删除单 Provider 并推进 generation |
| `clear_quota_snapshots_v2(integer,bigint)` | RPC 函数 | 显式全局删除并推进 epoch/generation |

## 手动刷新

桌面端在 `sync_to_supabase` 后会自动调用 `request_refresh()`。如需在认证上下文中手动触发，可调用：

```sql
select public.request_refresh();
```

返回示例：

```json
{
  "refreshed": true,
  "stale": false,
  "dirty_generation": 12,
  "refreshed_generation": 12,
  "started_at": "...",
  "finished_at": "...",
  "duration_ms": 1234
}
```

当 `dirty_generation <= refreshed_generation` 时，该函数会快速返回，不会重复刷新。

## 回滚

如需只回退 v7，必须先让所有 v2 客户端停止同步并备份持久额度行，然后删除四个 v2 RPC/helper、新增约束与列，并重新部署 v6 的 TTL/cron 与三个 v1 函数。该操作会重新引入 24/25 小时数据删除语义，不能只删除 v2 函数后继续运行；应通过受控反向迁移执行，而不是手工片段。

如需退出 v6 额度快照同步，先关闭所有客户端的跨设备额度同步并停止生产者，再执行：

```sql
select cron.unschedule(jobid)
from cron.job
where jobname = 'tokenledger-quota-snapshot-hourly-purge';

drop function if exists public.replace_quota_snapshots_v1(integer, bigint, jsonb);
drop function if exists public.get_quota_snapshots_v1();
drop function if exists public.clear_quota_snapshots_v1(integer);
drop function if exists private.purge_expired_quota_snapshots_v1();
drop function if exists private.validate_quota_snapshots_v1(jsonb);
drop function if exists private.quota_snapshot_reason_valid_v1(text);
drop function if exists private.quota_snapshot_timestamp_valid_v1(jsonb);
drop function if exists private.quota_snapshot_number_valid_v1(jsonb);
drop function if exists private.quota_snapshot_integer_valid_v1(jsonb, bigint, bigint);
drop function if exists private.quota_snapshot_text_valid_v1(jsonb, integer, boolean);
drop function if exists private.quota_snapshot_fail_v1(text);
drop table if exists private.quota_snapshots;
drop table if exists private.quota_snapshot_state;
```

`pg_cron` 可能同时服务其他任务，回滚 v6 不删除该 extension。清表会删除仍在有效期内的额度投影，执行前必须按受控变更流程备份和审查。

如只需退出 v5 多选/search 能力，先让所有客户端关闭 `multiFilterSearch` 并回到契约允许的 v1 fallback，再执行：

```sql
drop function if exists public.get_dashboard_stats_v2(uuid, jsonb);
drop function if exists public.get_usage_comparison_v2(uuid, jsonb);
drop function if exists public.get_usage_details_v2(uuid, jsonb, text, integer);
drop function if exists public.get_usage_entity_dashboard_v2(uuid, jsonb, jsonb, text, integer);
drop function if exists private.tokenledger_usage_details_core_v2(uuid, jsonb, jsonb, text, integer);
drop function if exists private.tokenledger_usage_comparison_core_v2(uuid, jsonb, jsonb);
drop function if exists private.tokenledger_usage_summary_v2(uuid, text, text, jsonb, jsonb);
drop function if exists private.tokenledger_usage_series_v2(uuid, timestamp, timestamp, text, jsonb, jsonb);
drop function if exists private.tokenledger_normalize_entity_v2(jsonb, jsonb);
drop function if exists private.tokenledger_normalize_query_v2(jsonb);
drop function if exists private.tokenledger_normalize_array_v2(jsonb, text);
drop function if exists private.tokenledger_normalize_singular_v2(jsonb, text);
drop function if exists private.tokenledger_search_match_v2(text, text, text, text, text);
drop function if exists private.tokenledger_ascii_trim_v2(text);
drop index if exists public.token_logs_user_machine_tool_model_time_id_idx;
```

如需继续回滚旧聚合层，可执行：

```sql
drop materialized view if exists public.token_logs_daily_by_tool;
drop materialized view if exists public.token_logs_daily_by_model;
drop materialized view if exists public.token_logs_by_tool;
drop materialized view if exists public.token_logs_by_model;
drop materialized view if exists public.token_logs_year_heatmap;
drop table if exists public.sync_state;
drop function if exists public.refresh_token_logs_summaries();
drop function if exists public.request_refresh();
drop function if exists public.get_dashboard_stats(uuid, text, text, text);
drop function if exists public.get_yesterday_stats(uuid, text, text);
drop function if exists public.sync_token_log();
drop function if exists public.immutable_date_parse(text);
drop index if exists public.token_logs_user_date_tool_idx;
drop index if exists public.token_logs_user_tool_model_idx;
drop index if exists public.token_logs_date_idx;
```

回滚不会删除 `token_logs` 表，也不会删除其原有 RLS 策略。
