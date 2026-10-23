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

1. 信息架构：四个子页与侧栏、锚点、顶栏统一（本 PR）。
2. 统一 Split by：同一份数据可按 Agent、模型、设备拆分，趋势柱与排行联动，选中一项后其他维度随之收窄；热力图与现有 YearHeatmap 合并，指标可切 Token、请求数、费用。
3. 请求子页指标：CSV 导出（全部页）、缓存命中率；输出速度只在来源记有耗时时给出，缺失时写明不可得，不按 0 显示；额度 Pace 沿用 `forecast-and-pace-v1.md`。

## 不做

- 不读取任何订阅凭据（ADR-004）。
- 「账号」维度：TokenLedger 的统计契约没有账号字段，Split by 用设备代替；契约增加账号前不伪造该维度。
