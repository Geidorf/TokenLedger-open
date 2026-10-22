# 本机行为分析契约 v1.2（T10.149；T10.151 只增字段并修正口径；T10.182 只增项目维度）

## 范围与事实源

`get_local_behavior_analysis({ query: LocalStatsQuery })` 是只读 Tauri 命令，仅从当前机器的 `token_logs` 计算完整区间聚合。输入沿用 Stats v2 的 `range`、`start`、`end`、`timezone`、`machines`、`tools`、`models`、`search`、`tokenMode`；输出是本机事实，不代表云端或未被扫描、已清理的原始日志。前端仅在本机范围调用它；云端显示能力边界。请求变化时旧响应不得覆盖新选择。

## 响应

命令返回 camelCase JSON：

```json
{
  "meta": {
    "source": "local",
    "complete": true,
    "range": "custom",
    "start": "2026-09-01",
    "end": "2026-09-23",
    "timezone": "Asia/Shanghai",
    "recordCount": 0,
    "firstRecordAt": null,
    "lastRecordAt": null,
    "sessionLimit": 100,
    "sessionsTruncated": false
  },
  "summary": { "tokens": 0, "inputTokens": 0, "outputTokens": 0, "cachedTokens": 0, "requests": 0, "activeDays": 0, "toolCount": 0, "sessionCount": 0, "modelCount": 0 },
  "tools": [{ "id": "Codex", "tokens": 0, "requests": 0, "sessionCount": 0 }],
  "sessions": [{ "id": "opaque-session-id", "tool": "Codex", "tokens": 0, "requests": 0 }],
  "dayHours": [{ "date": "2026-09-23", "hour": 10, "tokens": 0, "requests": 0 }],
  "modelHours": [{ "hour": 10, "model": "model-name", "tokens": 0, "requests": 0 }],
  "modelDays": [{ "date": "2026-09-23", "model": "model-name", "tokens": 0, "requests": 0 }],
  "requestSizes": [{ "model": "model-name", "requests": 0, "p50": 0, "p90": 0, "max": 0, "bins": [{ "lower": 0, "upper": 1000, "requests": 0 }] }]
}
```

`meta.start/end` 是实际查询的本地日历日期闭区间；`today` 截止当前时刻。`recordCount` 与各维度的 `requests` 字段统计实际入选的账本行；该字段为兼容现有统计命名保留，界面统一称“记录数”。来源粒度不完全一致，例如 ReasoniX 按会话记录，不能把分布中的每条记录都解释为单次请求。`firstRecordAt/lastRecordAt` 是入选记录时间，可用于说明本机账本实际覆盖。`complete` 仅表示对本机当前数据库的入选记录完成聚合。

`sessionLimit` 固定 100；`sessions` 按有效 Token 倒序取前 100，`summary.sessionCount` 仍是完整区间数量，`sessionsTruncated` 表示排行被截取。会话 ID 仅是来源标识，不从会话 ID、来源文件名或来源目录名推断项目；项目归属只来自用户开启后的本机项目索引（见下文「v1.2 演进：项目维度」）。其它聚合不受看板 `history` 200 条上限影响；零值桶可在前端按日期区间补齐。长区间最多沿用 `LocalStatsQuery` 自定义范围 731 天上限。

有效 Token = `inputTokens + outputTokens`。`cachedTokens` 是单列观察量，不重复并入有效 Token。所有维度使用同一过滤条件、区间和时区。`dayHours` 按选定时区的日期与小时分桶；`modelHours` 是选定范围内同一小时的跨日合计；`modelDays` 按本地日期与模型分桶。图上选择日期或小时属于前端交互筛选，不修改原始聚合。

## 界面规则

独立「行为分析」视图提供今日、近 3 天、近 7 天、近 30 天、自定义范围。近 N 天包括今天，按本地日历日期计算。范围变化会同步应用于全局时间查询；云端模式不调用本命令，也不得由有限 `history` 推断全量行为。日期点击可进入已过滤的活动明细。图例、提示和空态注明当前范围及本机覆盖。

## v1.1 演进（T10.151）

v1.1 不删除、不改名 v1 的任何字段，也不改变字段类型。新增的响应字段在类型上都是可选的：缺失表示响应来自不支持 v1.1 的实现，读者不得把缺失解读为 0 或“没有”。另有几处修正了 v1 已有字段的取值口径，字段名和类型都没变，版本记录中单列为“口径修正”，便于下游判断影响。

### 缺少会话 ID 的记录

来源缺少会话标识时，扫描器写入的空值、纯空白值与占位值 `unknown_session` 都表示“会话 ID 缺失”，不是一个真实会话。这些记录不进入 `sessions` 排行，不计入 `summary.sessionCount` 与 `tools[].sessionCount`；它们的有效 Token 与记录数仍计入 `summary`、所属工具以及日期、小时、模型各维度。

```json
{
  "summary": { "unknownSessionRecords": 3, "unknownSessionTokens": 1290 },
  "tools": [{ "id": "MiniMax", "tokens": 970, "requests": 2, "sessionCount": 0, "unknownSessionRecords": 2 }]
}
```

`summary.unknownSessionRecords` 是缺少会话 ID 的入选记录数，`summary.unknownSessionTokens` 是这些记录的有效 Token（`inputTokens + outputTokens`，不含缓存）。二者大于 0 时，界面应在会话数或会话排行旁注明“N 条记录缺少会话 ID”，不得把它们显示成一个会话。

`tools[].unknownSessionRecords` 是该工具缺少会话 ID 的记录数，各工具之和等于 `summary.unknownSessionRecords`。它大于 0 时，该工具的 `sessionCount` 只是有会话 ID 的那部分，界面须在工具行注明缺失；等于该工具的 `requests`（整源没有会话标识，如 MiniMax、腾讯 Marvis）时显示“会话未知”，不得显示“0 会话”（GLB-01：不用 0 掩盖未知）。

### 预设范围与“全部”的上限

预设范围与看板 Stats v2 同义，由后端按 `timezone` 的本地日历解析：`today` 从今日 0 点、`week` 从本周一 0 点、`month` 从本月 1 日 0 点、`year` 从 1 月 1 日 0 点起算，均截至当前时刻。预设不使用 `start/end`，客户端应传 null；旧客户端随预设发送的“近 N 天”日期一律被忽略。`meta.start/end` 是实际分析的本地日期，界面以它为准显示区间，并在页内写明当前范围名称（本周、本月等），不得把预设显示成“近 7/30/365 天”。`custom` 沿用 v1 的本地日期闭区间与 731 天上限。

`all` 在本命令中只覆盖截至今天、含今天在内的最近 `meta.rangeDayLimit`（731）个本地日历日，与自定义范围同一上限，不再对整库做无界聚合：

```json
{ "meta": { "range": "all", "start": "2024-09-24", "end": "2026-09-24", "rangeDayLimit": 731, "rangeTruncated": true } }
```

`meta.rangeTruncated = true` 表示该窗口之前仍有符合同一过滤条件的本机记录，此时 `meta.start` 为窗口首日，界面必须注明“仅统计最近 731 天”；为 false 时 `meta.start` 是区间内最早记录的日期（无记录时为今天），与 v1 一致。其它范围的 `rangeTruncated` 恒为 false。

### 记录大小分布的顺序与分箱

`requestSizes` 按 `requests`（记录数）倒序排列，记录数相同时按模型名的字节序升序；界面默认展示第一项，即记录最多的模型，而不是按字母排第一的模型。分箱沿用 v1 实现并在此写明：箱宽是 1000 的整数倍，从 1000 起按 1000 递增，直到箱数不超过 32；首箱下界为 0，每条记录恰好落入一个箱，最大值落在末箱。`p50/p90` 采用最近秩法。浏览器预览 mock 与原生实现使用同一排序与分箱，不作为另一套口径。

### 会话费用、起止时间与主模型（D5①）

用户决定 D5①（2026-09-24）：本机行为契约只增会话费用、起止时间与主模型，仅本机计算，不进云端同步、Supabase 或 Android。

```json
{
  "summary": { "totalCost": 1.34, "costComplete": true },
  "sessions": [{ "id": "opaque-session-id", "tool": "Codex", "tokens": 550, "requests": 3, "cost": 0.27, "firstAt": "2026-09-01 08:00:00", "lastAt": "2026-09-01 11:15:00", "topModel": "model-name" }]
}
```

- 费用单位为 USD，与看板本机 Stats v2 的 `summary.totalCost` 同源同口径：记录已存 `cost_usd` 时直接使用；缺失时按当前价格表估算，缓存读写分别计价，模型取最长匹配，未匹配时按工具回退价，再回退到 `default`。它是按价格表估算的预估费用，不是账单。同一查询下，`summary.totalCost` 与看板本机 `summary.totalCost` 一致；`all` 受上文 731 天窗口限制，这时只覆盖窗口内的记录。
- 解析出的单条费用不是有限的非负数（如损坏的存储值），视为该记录费用不可得。含这类记录的会话 `cost` 为 `null`，`summary.totalCost` 为 `null` 且 `summary.costComplete = false`；累计溢出同样按不可得处理。不可得不得显示或计为 0，也不得只加已知部分冒充总额。真实的 0 费用保持为 0。
- `summary.totalCost` 覆盖全部入选记录，包括缺少会话 ID 的记录；`sessions[].cost` 只覆盖该会话在所选区间内的记录。
- `firstAt/lastAt` 是会话在所选区间内首条、末条记录的时间，格式与 `meta.firstRecordAt` 相同（所选时区墙钟 `YYYY-MM-DD HH:MM:SS`）。会话延伸到区间外的部分不计入。
- `topModel` 是会话内有效 Token 最多的模型；有效 Token 相同时取记录数多者，仍相同时取模型名字节序靠前者。它可以为 `null`，表示会话没有可认定的模型；当前实现对每个会话都给出值，但读者仍须按可空处理，不得把 `null` 显示成某个模型。
- 会话 ID 仍只是来源标识，本节不推断项目或工作目录。D5② 的项目维度见下文 v1.2，项目费用沿用本节的单条估价。

### 刷新与数据时间（客户端规则）

行为页处于激活状态时，本机账本更新事件 `stats-updated`（扫描或同步完成）会触发以同一查询重新聚合，并以 400 ms 防抖合并。每次重新聚合都要整段重算，后端也无法取消，因此其余触发条件收窄为：

- 窗口隐藏期间收到的更新，留到窗口重新可见时统一重载。
- 窗口重新可见时，只有以下情况才重载：隐藏期间收到过更新、所选时区的本地日期已变，或更新事件监听注册失败。单纯切换窗口不重算。
- 重载进行中又收到更新时只记一次，等当前重载结束后补跑一次，不叠加并发的全量聚合。
- 新的读取（查询变化、手动刷新）或窗口隐藏，都会取消尚未触发的后台刷新。
- 每次读取都等更新事件监听注册完成（或确认失败）后才开始，所以两者之间的更新不会漏掉。注册失败时记录警告，此后每次窗口重新可见都重载。

查询身份（范围、自定义日期、时区、作用域、页面是否激活）变化时，先清空旧结果并显示加载状态，旧响应不得覆盖新选择。同一查询刷新时保留上一份结果直到新结果到达；内容未变时保持同一结果对象，避免图表重建或重播入场动画。刷新失败时保留上一份结果及其时间并报告错误，不得把它标成最新。

`useBehaviorAnalysis` 在原有 `data/loading/error/reload` 之外新增 `refreshing`（同一查询正在刷新，旧结果仍在显示）和 `updatedAt`（当前结果的接收时间，ISO 8601）。`loading` 只表示当前查询还没有结果（首次加载或查询变化）。行为页标注“刷新中”或“更新于”时使用这两个字段，不得借用看板统计的刷新时间。

## v1.2 演进：项目维度（T10.182；T10.155 方案 PD-6、T10.165 本机索引）

v1.2 只增：不删除、不改名 v1.1 的任何字段，不改变字段类型，也不改变 v1.1 字段的取值。新增的请求参数与响应字段在类型上都是可选的。整个 `meta.projectDimension` 缺失，表示响应来自不支持项目维度的实现（v1.1 及更早），或本机项目索引读不出来（见下文错误码）；读者一律按“后端不支持”处理，不得把缺失解读为“已关闭”或 0。

### 前提与隐私

- 用户决定 D5②（2026-09-24 逐条确认）：项目维度默认关闭，用户在设置「数据与帮助」中阅读读取说明并确认后才开启；只保存工作目录的末级文件夹名或固定分组（主目录、磁盘根目录、临时目录、托管会话），不保存完整路径与哈希；项目数据只在本机，不进入 Stats v2、云同步、Supabase、Android、分享海报、HTML 简报与 CSV 导出。需求见 REQUIREMENTS GLB-13，设计见 DESIGN §4.9 与 `docs/design/project-dimension-v1.md`，决策见 PROJECT ADR-016。
- 项目归属只来自本机项目索引（T10.165，本机库 schema v13 的 `local_session_projects` 与 `local_project_index_state`）为该会话记录的文件夹名或固定分组，不从会话 ID、来源文件名或来源目录名推断。开关、状态与重建由 `get_project_dimension_status`、`set_project_dimension`、`rebuild_project_index` 管理；本命令只读索引，不写入，也不触发索引。
- 项目字段只出现在本命令的响应中。响应里没有路径、路径哈希、盘符或用户名，失败原因只有固定原因码。
- 「隐藏项目名」是前端显示状态：开启后项目名与可由名称推出的项目键都不渲染，本命令的请求与响应不因此改变。
- 版本分配（root 决定 R-5，2026-09-25）：项目字段为 v1.2；T10.156 信息架构 v2 的只增字段（`tools[].cost`、`toolDays`、`sessions[].lastRecordId`、`summary.sessionMedianTokens`、`sessionSizes`）与按项目随时间的构成 `projectDays[]` 为 v1.3，由各自的实施任务写入。方案草案里项目级的 `inputTokens/outputTokens/cachedTokens/firstAt/lastAt` 与余量的 Token 分项不在 v1.2，需要时再只增。

### 请求

```ts
get_local_behavior_analysis({ query: LocalStatsQuery, projects?: string[] | null })
```

- `projects` 是可选的顶层参数，不放进 `LocalStatsQuery`：后者是 Stats v2 的共享查询形状，项目维度不进入跨端契约。缺失、`null` 与空数组都表示不筛选；只发 `query` 的旧客户端得到的 v1.1 字段与 v1.1 完全相同。
- 取值是响应返回的不透明 `key`，另有保留值 `@unattributed`，表示全部未归属用量。前端不得用项目名拼出键。重复的键去重；不认识的键不匹配任何记录，也不报错。
- 筛选对所有维度同时生效：`summary`、`tools`、`sessions`、`dayHours`、`modelHours`、`modelDays`、`requestSizes`、项目字段本身，以及 `all` 的 `meta.rangeTruncated` 判断。只有 `meta.projectDimension.indexedSessions/pendingSessions` 描述索引覆盖，不受项目筛选影响。
- 错误码是固定字符串，从不带 SQLite 原文、路径或其它原始错误文本：
  - 项目维度未采集（`state` 为 `disabled` 或 `consent_required`）时传入非空 `projects`，命令以 `project_dimension_disabled` 失败，不静默忽略，避免界面把未过滤的数据当作过滤结果显示。前端收到关闭事件时清空筛选。
  - 本机项目索引读不出来（例如索引表缺失或损坏；root 决定 R-32）时传入非空 `projects`，命令以 `project_dimension_unavailable` 失败。不带筛选时命令照常成功：v1.1 字段不变，只省略整个 `meta.projectDimension` 与全部项目字段，索引故障不让行为页失败。

### 响应新增字段

```json
{
  "meta": {
    "projectDimension": { "state": "ready", "indexedSessions": 4, "pendingSessions": 1, "filter": [] }
  },
  "summary": { "tokens": 1000, "requests": 8, "sessionCount": 5, "unknownSessionRecords": 1, "unknownSessionTokens": 50, "totalCost": 0.4, "costComplete": true },
  "projects": [
    { "key": "n:sample-app", "label": "Sample-App", "kind": "named", "tokens": 600, "requests": 4, "sessionCount": 2, "cost": 0.3, "share": 0.6,
      "tools": [{ "id": "Codex", "tokens": 450 }, { "id": "Claude", "tokens": 150 }] },
    { "key": "@home", "label": null, "kind": "home", "tokens": 100, "requests": 1, "sessionCount": 1, "cost": 0.02, "share": 0.1,
      "tools": [{ "id": "Claude", "tokens": 100 }] }
  ],
  "projectLimit": 50,
  "projectsTruncated": false,
  "projectsRemainder": null,
  "unattributed": {
    "tokens": 300, "requests": 3, "sessionCount": 2, "cost": 0.08, "share": 0.3,
    "reasons": [
      { "reason": "unsupported_source", "tokens": 200, "requests": 1, "sessionCount": 1, "share": 0.2 },
      { "reason": "pending", "tokens": 50, "requests": 1, "sessionCount": 1, "share": 0.05 },
      { "reason": "missing_session", "tokens": 50, "requests": 1, "sessionCount": null, "share": 0.05 }
    ]
  },
  "sessions": [
    { "id": "opaque-session-id", "tool": "Codex", "tokens": 450, "requests": 3,
      "project": { "key": "n:sample-app", "label": "Sample-App", "kind": "named" } },
    { "id": "opaque-session-id-2", "tool": "Antigravity", "tokens": 200, "requests": 1,
      "project": null, "projectReason": "unsupported_source" }
  ]
}
```

**`meta.projectDimension`**

- `state` 与 `get_project_dimension_status` 同词：`disabled`（未开启）、`consent_required`（已开启但授权版本低于当前读取说明，须重新确认）、`indexing`（采集中，回填未完成）、`ready`（回填完成）、`failed`（回填失败，已存的归属仍然有效）。
- `disabled` 与 `consent_required` 时对象里只有 `state`，响应不含任何其它项目字段，也没有 `sessions[].project/projectReason`；索引里即使还留有旧授权下的行也不读取。
- `indexing`、`ready`、`failed` 时另有：
  - `indexedSessions`、`pendingSessions`：所选范围与 v1.1 过滤条件下（不计项目筛选）已有索引行、尚无索引行的真实会话数；
  - `filter`：生效的项目筛选，去重后按码点序，不筛选时为 `[]`；
  - `lastFailure`：只在 `failed` 时出现，取固定原因码 `database_error`、`internal_error` 或 `null`（原因未知），从不含路径或原始错误文本。索引里存的其它值一律报为 `null`；客户端同样把其它任何值当作 `null`，不因此丢弃项目字段。

**项目键与名称**

- `kind` 取 `named`、`home`、`root`、`temp`、`managed`。
- 命名项目的 `key` 为 `n:` 加文件夹名的 Unicode 小写形式，由索引写入时清洗后的末级文件夹名得出；`label` 是同一键在整个本机索引中被最多会话使用的写法，同数取码点序靠前者。名称与所选范围无关，同一项目换范围后显示同一个名字。
- 命令读取时由索引里存的名称重新算出键，不采用索引里存的键，所以 `key` 恒等于 `n:` 加 `label` 的小写形式；客户端核对这一点。
- 固定分组的 `key` 为 `@home`、`@root`、`@temp`、`@managed`，`label` 为 `null`，由前端显示本地化名称。
- `key` 只由名称得出：不是路径，也不是路径哈希，不携带比 `label` 更多的信息。不同位置的同名文件夹合并为一个项目，这是只保存末级文件夹名的已知限制。

**`projects[]`、`projectsTruncated`、`projectsRemainder`**

- `projects[]` 是所选范围与过滤条件下有记录的项目与固定分组，按有效 Token 降序、同值按 `key` 的码点序，最多 `projectLimit`（50）个。一个会话按它的索引行整体归入一个项目，同一会话的全部入选记录都算入该项。
- 每项有 `key`、`label`、`kind`、`tokens`（有效 Token = 输入 + 输出，缓存不计入）、`requests`（记录数）、`sessionCount`、`cost`、`share` 与 `tools`。`tools` 是该项的工具构成 `[{ id, tokens }]`，按有效 Token 降序、同值按工具名字节序；`id` 与顶层 `tools[].id` 同值。
- 超过 50 个时 `projectsTruncated = true`，其余项目合并为 `projectsRemainder = { tokens, requests, sessionCount, cost, share, projectCount }`；否则 `projectsTruncated = false`、`projectsRemainder = null`。

**`unattributed`**

- `{ tokens, requests, sessionCount, cost, share, reasons }` 是无法归到任何项目的用量。它不并入任何项目，界面不得把它显示为 0 或“其它项目”。`sessionCount` 与 `summary.sessionCount` 同口径，不含缺少会话 ID 的记录。
- `reasons[]` 按固定顺序列出，没有记录的原因省略：
  - `unsupported_source`：来源不记录工作目录，例如 Antigravity、Trae、腾讯 Marvis；
  - `unresolved`：来源支持，但日志已清理或不可读、字段缺失、路径无效或超出读取上限；
  - `pending`：会话还没有索引行（回填未完成，或会话在最近一次索引之后才出现）；
  - `missing_session`：缺少会话 ID，与 v1.1 的 `summary.unknownSessionRecords/unknownSessionTokens` 是同一批记录。这些记录不是会话，它的 `sessionCount` 恒为 `null`（未知），不是 0。
- 每个原因有 `reason`、`tokens`、`requests`、`sessionCount`、`share`，不单列费用。

**费用与占比**

- `projects[].cost`、`projectsRemainder.cost`、`unattributed.cost` 是 D5① 单条估价之和，与 `sessions[].cost`、`summary.totalCost` 是同一套估价（USD，预估费用，不是账单）。
- 任一入选记录的费用不可得时，该项费用为 `null`，不记 0，也不只加已知部分（GLB-01）。因此 `summary.totalCost` 为 `null`，当且仅当项目、余量与未归属中至少一项为 `null`。真实的 0 仍是 0，例如没有未归属记录时 `unattributed.cost = 0`。
- 各项的 `share = tokens / summary.tokens`，分母包含未归属用量；客户端按相对误差 1e-9 核对。`summary.tokens = 0` 时所有 `share` 为 `null`（不可得），不是 0。

**`sessions[].project` 与 `projectReason`**

- 只在 `indexing`、`ready`、`failed` 时出现。`project` 为 `{ key, label, kind }`，与 `projects[]` 中同键的条目一致；`project = null` 时必带 `projectReason`，取 `unsupported_source`、`unresolved` 或 `pending`。排行里的会话都有会话 ID，所以没有 `missing_session`。

### 不变量（契约测试）

1. `Σ projects[].X + (projectsRemainder?.X ?? 0) + unattributed.X = summary.X`，X 为 `tokens`、`requests`、`sessionCount`。
2. `Σ unattributed.reasons[].X = unattributed.X`，X 为 `tokens`、`requests`，以及 `sessionCount`（`missing_session` 计 0）。
3. 同一会话在 `sessions[].project` 与 `projects[]` 中的键、名称与类别一致；未截断时每个会话的项目都在 `projects[]` 里，每个 `projectReason` 都在 `unattributed.reasons[]` 里。
4. 带 `projects = [K]` 筛选时，`summary.tokens`、`requests`、`sessionCount` 等于不带筛选时 `projects[K]` 的对应值（K 未被截断）。
5. `state` 为 `disabled` 或 `consent_required` 时不出现任何项目字段；此时带非空筛选返回 `project_dimension_disabled`。
6. `missing_session` 的 `tokens`、`requests` 等于 `summary.unknownSessionTokens`、`summary.unknownSessionRecords`（没有该原因时两者为 0）。
7. 采集中且不带筛选时，`indexedSessions + pendingSessions = summary.sessionCount`，`pending` 原因的 `sessionCount = pendingSessions`（没有该原因时为 0）。带筛选时覆盖计数仍是全区间的，本条不适用。

### 旧客户端与失败即关闭（客户端规则）

- 旧客户端只发 `query`，请求不变，响应的 v1.1 字段不变，忽略新增字段即可。
- 前端在 `useBehaviorAnalysis` 中对每个响应解析一次项目字段（`src/utils/contracts/behaviorProjects.ts`），只保留已知字段。任何一项违反本节规则，就丢弃全部项目字段（包括 `meta.projectDimension`），按不支持项目维度的后端处理；不展示部分或互相矛盾的项目数据，v1.1 字段不受影响。逐项核对的规则：
  - 类型或取值错误，关闭时带项目内容；
  - 名称含路径分隔符、控制字符或双向控制字符，键不是 `n:` 加名称小写形式或固定分组键；
  - 占比与 `tokens / summary.tokens` 的相对误差超过 1e-9；
  - 不变量 1–3、5 不成立；不变量 6 在响应带 `summary.unknownSessionRecords/unknownSessionTokens` 时核对，不变量 7 在 `filter` 为空时核对。
- `lastFailure` 不是固定原因码时按 `null` 处理，不算违反。响应没有 `meta.projectDimension`（旧后端或索引读不出来）时原样放行，界面按“后端不支持”处理。
- 浏览器预览 mock 按同一规则聚合，只用虚构项目名。默认关闭；`?behaviorProjects=indexing|ready|failed|consent_required` 可预览对应状态，`?behaviorProjects=unavailable` 预览索引读不出来。

## 版本记录

- v1（T10.149）：首版。
- v1.1（T10.151）：
  - 新增响应字段（均可选）：`summary.unknownSessionRecords`、`summary.unknownSessionTokens`、`tools[].unknownSessionRecords`；`meta.rangeDayLimit`、`meta.rangeTruncated`；D5① 的 `sessions[].cost/firstAt/lastAt/topModel`（`topModel` 可为 `null`）与 `summary.totalCost/costComplete`。
  - 客户端 hook `useBehaviorAnalysis` 的返回值新增 `refreshing`、`updatedAt`。它们是 hook 状态，不是响应字段，总会返回，不适用上面的“可选”。
  - 口径修正（字段名与类型不变）：
    - `summary.sessionCount` 与 `tools[].sessionCount` 不再把空值、纯空白与 `unknown_session` 计为会话，`sessions` 排行也不再出现它们。
    - 预设范围按本地日历解析，忽略 `start/end`。
    - `all` 只覆盖最近 731 个本地日历日，不再是整库。
    - `requestSizes` 改为按记录数倒序、同数按模型名，并写明分箱规则。
    - hook 的 `loading` 只表示当前查询尚无结果；同一查询刷新改由 `refreshing` 表示，并保留旧结果。
  - 客户端随 `stats-updated` 刷新。窗口重新可见时，只在隐藏期间有过更新、跨日或监听注册失败时才重载；进行中的重载不叠加。
- v1.2（T10.182，T10.155 方案 PD-6）：
  - 新增可选请求参数 `projects`（顶层，不进 `LocalStatsQuery`，保留值 `@unattributed`）与错误码 `project_dimension_disabled`、`project_dimension_unavailable`。
  - 新增响应字段（均可选）：`meta.projectDimension`；项目维度采集中另有 `projects[]`、`projectLimit`、`projectsTruncated`、`projectsRemainder`、`unattributed` 与 `sessions[].project/projectReason`。索引读不出来时省略 `meta.projectDimension`（root 决定 R-32）。
  - 口径说明（字段名、类型与取值不变）：“会话 ID 不推断项目”改写为“不从会话 ID、来源文件名或来源目录名推断；项目只来自用户开启后的本机项目索引”。
  - 客户端：`useBehaviorAnalysis` 对项目字段做失败即关闭的解析，核对名称键、占比与不变量 1–3、5–7，`lastFailure` 非固定原因码按 `null` 处理；hook 暂不发送项目筛选，筛选界面归 PD-7（后续版本已接入：`useBehaviorAnalysis` 现会发送 `projects`）。
