# 用量分析对齐 magpie（v1）

状态：实施中（2026-10-23 起）。适用平台：桌面端。来源：用户决定「用量分析对齐 magpie 的用量分析」，参照 magpie（MIT）Usage 页的公开源码与截图。

## 目标

桌面「用量」的信息架构、聚合方式与关键指标与 magpie Usage 页一致，数据口径仍守 TokenLedger 铁律：有效 Token = 输入 + 输出，缓存读写单列。先做信息架构，再做视觉。

## 子页对照

| magpie | TokenLedger | 数据来源 | 说明 |
| --- | --- | --- | --- |
| Overview | 概览（`dashboard`） | `StatsData` | 结论句、指标、趋势、构成、洞察与热力图；额度只留要点。 |
| Requests | 请求（`logs`） | `get_usage_details` 分页 | 原「记录」与「活动明细」合并；筛选、搜索、展开详情、整段会话分析。 |
| Sessions | 会话（`behavior`） | 行为分析 | 原「行为分析」改名，功能不变。 |
| Overview 内的额度 | 额度（`allowances`） | 额度来源 | 单列一页，含窗口、重置时间与 Pace。 |
| Context | 不设 | — | 需要逐请求的提示词构成（system/tools/memory/files/results/chat），本机扫描与云端都没有这份数据。 |

## 分步

1. 信息架构：四个子页与侧栏、锚点、顶栏统一（已合并，#7）。
2. 统一 Split by（#12）：概览的分布模块改为「用量拆分」，同一份数据按 Agent、模型、设备拆分，指标可切 Token、请求、费用，选中一项后其他维度随之收窄，热力图（现有 YearHeatmap）跟着画这一项的逐日用量。契约里 Agent × 模型只有有效 Token，交叉时请求与费用不可得；设备不与其他维度交叉；逐日热力图只有 Token，暂不提供请求、费用热力。趋势图仍按 Agent 堆叠，暂不随焦点。
3. 请求子页指标：CSV 导出（全部页）、缓存命中率；输出速度只在来源记有耗时时给出，缺失时写明不可得，不按 0 显示；额度 Pace 沿用 `forecast-and-pace-v1.md`（额度子页已有）。
   - 导出：前端沿当前范围与筛选的游标逐页取完（每页 100 行，单次最多 50,000 行，超过时提示缩小范围），生成 CSV 交给新命令 `export_usage_csv` 写到应用数据目录的 `tokenledger_requests.csv`（带 BOM，路径由后端固定）。本地与云端走同一条路径。列：`time, tool, model, provider, source, granularity, requests, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cached_tokens, cache_hit_rate, cost_usd, usage_estimated, session_id, machine_id`；缓存读写只在拆分可证明时分列，缺失写空；`source` 在本机缺省为 `scan`，云端聚合不带来源时留空；`usage_estimated` 表示 Token 用量是否为约数；以 `= + - @` 开头的文本加单引号，防止表格软件当公式执行。设置里原有的「导出 CSV」仍是整本账本的原始导出，两者并存。
   - 缓存命中率 = 缓存读 ÷（输入 + 缓存读）。汇总条与展开行在读写拆分可证明时显示，否则写不可得。
   - 输出速度：扫描记录没有请求耗时，不按 Token ÷ 时间间隔推算。网关与导入记录带整次请求耗时，2026-10-23 起明细在这些行上带可选 `latencyMs`（契约 §2.5），请求子页展开行与 CSV 据此给出输出速度，其余行不显示。

## 不做

- 不读取任何订阅凭据（ADR-004）。
- 「账号」维度：TokenLedger 的统计契约没有账号字段，Split by 用设备代替；契约增加账号前不伪造该维度。
