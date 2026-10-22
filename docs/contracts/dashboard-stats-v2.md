# Dashboard Stats v2 契约

本契约定义本地 Tauri、Supabase RPC、React 与 Android 共同消费的看板形状。v2 是对现有 v1 的向后兼容扩展；字段名使用 camelCase。

## 1. 不变量

- `effectiveTokens = inputTokens + outputTokens`。
- `cachedTokens = cacheReadTokens + cacheWriteTokens`（旧数据无法拆分时仅保证 combined）。
- 所有当前期与上一期数据使用相同的时区、设备、工具、模型、文本搜索和 Token 模式。
- 不可得字段应缺失/null，并通过 capability/status 表达；不得填 0 伪装成已知。

## 2. 顶层

```json
{
  "summary": {},
  "tools": {},
  "models": {},
  "trends": [],
  "comparison": {},
  "heatmap": {},
  "dailyCosts": {},
  "history": [],
  "historyPage": {},
  "machineDistribution": [],
  "machines": [],
  "quotas": [],
  "meta": {}
}
```

现有 v1 字段保持；`comparison`、`historyPage`、`machineDistribution`、`dailyCosts`、`quotas` 为可选扩展。
`summary.totalTokens/inputTokens/outputTokens/cachedTokens/totalCost/totalRequests/avgTokensPerReq`
以及顶层 `tools/models/trends/heatmap/history` 是 v1 必填核心；缺失或非有限数值属于 malformed 响应，客户端必须显示不可用/错误，不得静默补 0。缓存拆分等文档标为可选的字段仍可缺失。

`tools` 与 `models` 的每项 composition 可含可选 `cacheRead`/`cacheWrite`（读缓存/写缓存拆分，`cached = cacheRead + cacheWrite`）。二者只在来源能证明拆分时输出（本地按行 `cache_write_tokens` 校验，云端按同一口径），任一缓存行缺 provenance 时整项剥离这两个字段——缺失表示「无法拆分」，不得被客户端解读为 0 或空。

本地 `history[]`、明细 `items[]`（含实体明细）可附加 `usageProvenance: reported | estimated`（T10.315），独立于缓存量与缓存读写是否完整；真实用量的缓存为 0 仍是 `reported`。本机扫描从持久来源列投影，网关已记账行输出 `reported`。旧响应与云端小时聚合允许缺失，客户端不得要求此字段或根据缺失断言真实来源；React 保留旧展示回退，Android 继续忽略未知可选字段。本扩展不新增云端存储列或 RPC 要求。

### 2.1 趋势桶

`trends[]` 每项形如 `{ "date": <桶键>, "<工具名>": <有效 Tokens>, ... }`。普通工具键的数值只包含输入 + 输出；`date` 与所有 `__*` 键都是系统保留字段，不得计入 Token。云端当前使用 `__requests` 表示该桶请求数，读者必须忽略它以及未来新增的其他 `__*` 元数据。

桶键按范围规范化：`today` 使用 `HH:00`，`week/month/all` 使用 `YYYY-MM-DD`，`year` 使用 `YYYY-MM`；`custom`（T10.108）单日区间使用 `HH:00`、多日区间使用 `YYYY-MM-DD`。新生产者只写这些格式；迁移期读者仍须接受历史本地年桶 `M`/`M月`，但不得继续产生历史格式。日期、小时或月份越界的键属于未知粒度，洞察层不得猜测。

本地 `today/week/month/year/custom` 可预置完整轴，因此会包含进行中与未来零桶；洞察截止点优先使用 `comparison.window.currentEnd`，其次 `meta.generatedAt`。`meta.timezone` 是桶时区的来源事实，且必须与 `meta.query.timezone` / `comparison.window.timezone` 一致；只有 bridge 注入的 query 时区不能证明旧响应桶语义。当前桶只可作为候选并标注「进行中」，未来桶不得进入观测数、日均或异常基线。来源时区缺失或三者冲突时，时间洞察应整体降级不可用。

### 2.2 设备分布

```json
[
  {
    "value": "studio-pc",
    "tokens": 15300000,
    "inputTokens": 12000000,
    "outputTokens": 3300000,
    "cachedTokens": 4100000,
    "cacheWriteTokens": 200000,
    "requests": 1820,
    "cost": 18.42
  }
]
```

`machineDistribution` 必须在主看板的完整 canonical query 上按非空 `machine_id` 聚合，不能从有限的 `history` 预览推导。`tokens = inputTokens + outputTokens`，缓存不得再次并入有效 Token；客户端选择“含缓存”口径时可显示 `tokens + cachedTokens`。`requests` 与主汇总使用相同请求口径。

结果按 `tokens DESC`、设备原始 ID 的 unsigned UTF-8 bytes 升序稳定排列。字段缺失表示服务端尚不支持该可选扩展；空数组表示支持但当前查询没有设备记录。客户端不得把缺失解释为零设备，也不得伪造分布。桌面主看板只在云端 `meta.query.machines=[]` 且至少有两项时显示该图表；本地实现仍返回同形状用于契约一致性，但本地界面不展示。

### 2.3 每日预估费用（T10.118b，可选）

```json
{
  "coverage": {
    "start": "2026-07-01",
    "end": "2026-07-15",
    "timezone": "Asia/Shanghai",
    "state": "complete"
  },
  "days": [
    { "date": "2026-07-14", "amountUsd": 0.42, "status": "recorded-estimate" },
    { "date": "2026-07-15", "amountUsd": null, "status": "unavailable", "reason": "missing-cost" }
  ]
}
```

`dailyCosts` 独立于 `heatmap`、`trends`、`summary.totalCost`，不修改这些旧字段的口径或 wire 形状。云端公开 `get_dashboard_stats_v2(p_user,p_query)` 的同一 canonical 用户/范围/设备/工具/模型/search 过滤集合一次聚日，日键采用 `meta.query.timezone` 的当地公历日期；不能从有限明细、年度热力图或月桶分摊金额。只输出 `sum(input_tokens + output_tokens) > 0` 的既有活跃日，按 `date` 严格升序且不重复；所有该日匹配行（包括零有效Token行）都参与成本完整性检查。可信空集返回 `days: []`，不生成货币零。

此可选扩展以前述旧核心成功生成有效响应为前提。旧必填总成本、工具成本等仍使用原聚合行为；若它们发生 float8 溢出或旧核心非法，沿用整条请求失败及客户端既有错误恢复，不承诺返回 dailyCosts，不伪造零值、钳位金额或改变旧聚合以强行生成扩展。例如同工具两笔 1e308 可在旧核心成本聚合时先溢出；下述日金额 numeric 上界保护只约束能够到达该扩展的执行分支，不保证此类生产 RPC 成功。

`coverage.start/end` 是当前 query 的当地日期闭区间，`start` 仅 `all` 允许且必须为 null；其余依次是今日、周一、月初、年初或 custom.start，`end` 是实际截止当地日期。数据查询仍截止精确请求时刻，custom 的未来 end 截到现在；历史 custom.end 不超过用户请求日期。客户端校验覆盖时，截止点优先 `comparison.window.currentEnd`，其次 `meta.generatedAt`，无可信截止点时新能力不可用。coverage.timezone 必须是有效时区，并与 `meta.timezone`、canonical `meta.query.timezone`、存在时的 comparison.window.timezone 一致。日期必须是真实公历日，days 必须落在覆盖区间内，覆盖起止必须与 query 和截止点一致。

`coverage.state` 为 `complete | partial`：complete 只证明本次既有数据库查询及整个窗口响应完整，不证明scanner/同步历史绝无漏采，也不证明其中每个金额都可得。partial 不能展示任何日的金额；其中行必须 `unavailable`、amountUsd=null、reason=incomplete-coverage。当前生产者完整执行一次查询后只产生 complete，不用截断天数伪称完整。year/all 响应体积和执行计划须纳入回归预算；超过可接受资源时不能截断后标 complete。

日行是判别联合：

- `status: recorded-estimate`：`amountUsd` 为严格正的有限 JSON number，reason 缺失。所有匹配记录的 cost_usd 均非空、严格正且有限；以 numeric 累加并在转换 float8 前检查有限上界。含现有默认价格估算也可标此状态，不代表供应商实付或逐笔核价；估算金额按上传设备当时的价格表冻结，内置价格表更新不会重算已上传的行（见 DESIGN §2.5）。
- `status: unavailable`：`amountUsd` 必须显式 null，reason 必须是 `incomplete-coverage | missing-cost | invalid-cost | legacy-zero`。同日多原因按此顺序取第一个；invalid-cost 包含非有限/负数/累计溢出。历史0没有价格来源依据，使用legacy-zero，不修改原存储值，不只加已知部分冒充总额。

使用者呈现名称“预估费用”，说明层“按已有记录汇总，未逐笔核价”，沿用现有币种与隐藏费用；不能把 recorded-estimate 简称已核价或账单金额。本数据能力切片不自动开放页面入口。

缺字段、null、旧RPC和旧缓存表示能力不可得；TS/Kotlin 对结构、日期、时区/覆盖或状态金额组合无效的可选扩展整体丢弃，保留合法旧核心数据，不把部分合法天数作为完整能力。新字段的未知附加键可忽略；未知state/status/reason使扩展不可用。Rust云端JSON桥继续透传可选字段，消费边界完成上述校验；本地SQLite暂不生产该字段。缓存不补默认数组/金额，已有新字段必须按同形状保留，重新读取仍走同一校验。

### 2.4 缓存节省（T10.162，可选）

```json
{
  "summary": {
    "cachedTokens": 9000000,
    "cacheReadTokens": 8000000,
    "cacheWriteTokens": 1000000,
    "cacheSavedUsd": 21.6,
    "cacheSavings": {
      "readSavedUsd": 21.6,
      "writePremiumUsd": 0.75,
      "netSavedUsd": 20.85,
      "fallbackPricedReadTokens": 0,
      "fallbackPricedWriteTokens": 0,
      "priceBasis": "local-prices"
    }
  }
}
```

只增不改的扩展，`meta.contractVersion` 仍为 2。口径见 `docs/design/cache-savings-net-v1.md` §3.1；金额单位 USD，单价的解析与兜底沿用预估费用。

- `cacheSavedUsd`：既有字段，语义不变，即缓存读取节省（毛值），不扣写入溢价；读者不得把它当作净节省。旧客户端照旧只读它。
- `cacheSavings` 的字段：
  - `readSavedUsd`：缓存读取节省 = Σ 读取量 × max(输入价 − 缓存读价, 0) ÷ 10⁶，与同一 summary 的 `cacheSavedUsd` 相同。
  - `writePremiumUsd`：缓存写入溢价 = Σ 写入量 × max(缓存写价 − 输入价, 0) ÷ 10⁶，不小于 0。
  - `netSavedUsd`：缓存净节省 = `readSavedUsd − writePremiumUsd`，可为负（写入溢价高于读取节省）。
  - `fallbackPricedReadTokens`、`fallbackPricedWriteTokens`：单价来自兜底的读取量与写入量，非负整数。只有按型号命中价格表的显式条目、且条目写了 `input` 与对应的 `cache_input` / `cache_write`，才算列价；工具兜底键、`default`、自动发现的「待核价」条目与缺省字段都算兜底。缺缓存读价按输入价 × 0.1、缺缓存写价按输入价 × 1.25 估算，与预估费用同一兜底。
  - `priceBasis`：`local-prices` 表示按本机当前价格表估算（本机统计，以及桌面对旧云端的桥接）；`uploaded-prices` 表示云端按各设备上传时的价格表冻结（B 期）。
- 精度：生产端用全精度 double 逐行或按（工具, 模型）分组相加，不做中间舍入。三个金额只在呈现层各自舍入，不用舍入后的两项反推净值。
- 出现条件：只在同一 summary 的 `cacheReadTokens/cacheWriteTokens` 读写拆分成立时才可能出现，即范围内全部缓存行的读写拆分都可证明（§2、T10.88）；拆分成立不保证对象出现（例如未声明本节能力的旧来源，或 B 期云端的同期与明细 summary）。缺失即不可得，不得补 0。范围里混有拆分不可证明的记录时（例如只上报缓存读取、不上报写入量的 Codex），三个金额一起不可得，不按可证明的部分计算。
- 输出位置：本机在主看板与实体看板的 `summary`、`comparison.current/previous.summary` 和明细 `filteredSummary` 输出，三处代码路径按同一逐行公式与兜底规则计算（两份实现逐位对照测试，见 T10.183）；云端在 B 期迁移后只保证主看板 `summary`，其余位置随 B3 扩展。
- `meta.capabilities.cacheSavings = true` 表示生产者按本节计算：
  - 能力为 true 而对象缺失：该范围不可得。
  - 能力缺失：旧来源。桌面可对旧云端主看板按本机价格表桥接（`priceBasis: local-prices`），Android 显示不可得。
  - 声明本能力的 RPC 必须继续输出 `cacheSavedUsd`（与 `readSavedUsd` 相同），使 B 期云端与桌面 A2 呈现的上线先后不影响旧读者（root 决定 R-27）。
  - RPC 已声明能力时，桌面直接采用 RPC 的对象，不再桥接；汇总与模型行的读写拆分对不上时，拆分、`cacheSavedUsd` 与本对象一起剥离。
- 消费端校验。任一不满足就丢弃整个对象，保留旧核心字段（含 `cacheSavedUsd`）：
  - 三个金额都是有限数，`readSavedUsd` 与 `writePremiumUsd` 都 ≥ 0；
  - |net − (read − premium)| ≤ 1e-6 × max(1, read + premium)；
  - `cacheSavedUsd` 同时存在（非 null）时，必须是有限数，且与 `readSavedUsd` 的差不超过同一容差；否则丢弃本对象（桌面与 Android 一致，root 决定 R-26）；
  - 同一 summary 的 `cacheReadTokens`、`cacheWriteTokens` 是非负整数，且二者之和等于 `cachedTokens`；
  - 两个兜底计数是非负整数，分别不大于读取量与写入量；
  - `priceBasis` 属于已知取值；未知附加键忽略。
- 共享 fixture：`cache-savings-v2.json` 覆盖列价正值、兜底计数、负净值、已知 0、微小值与云端形状；`cache-savings-invalid-v2.json` 覆盖拆分不可证明时对象缺失，以及非法形状整体丢弃而核心保留。

### 2.5 网关记录来源与去重（T10.264，可选，U-95）

本地网关（ADR-017）先将有用量的尝试持久保存到 `app_data/gateway/usage-accounting-v1.sqlite3`，再写可轮转的 `usage-v1.jsonl` 诊断记录（T10.306g）。旧 `usage-v1.jsonl` 与 `.1` 仅在首次导入时按计费身份幂等读取；统计使用持久库，不再随诊断日志轮转丢失。记录字段映射见 `src-tauri/src/gateway/ledger.rs` 的 `LedgerRecord`。本节规定它如何进入本契约的统计；不改变有效 Token、缓存与成本口径，`meta.contractVersion` 仍为 2。

**计入条件。** 一条网关记录计入统计，当且仅当 `input + output + cacheRead + cacheWrite > 0`。零 Token 的失败请求只出现在网关请求日志，不计入请求数、不参与去重；`ok = false` 但上游已返回用量的记录照常计入。

**维度映射。** 每条计入的网关记录等价于一行明细，`requests = 1`：

| 统计维度 | 取值 |
|---|---|
| tool | `agent` 映射到扫描侧工具名：`codex→codex`、`claude-code→claude`、`gemini-cli→gemini`、`pi→pi`；其余已识别 Agent 原样使用；`agent` 缺失时为 `gateway` |
| model | `upstreamModel`（实际计费的上游模型）；为空时取 `requestedModel` 去掉首个 `供应商ID/` 前缀后的部分 |
| provider | `provider`（供应商 ID）。只有网关记录带此字段，扫描记录缺失即未知，不填空串；本期不进入 canonical query 筛选 |
| machine_id | 本机设备 ID（网关只在本机运行） |
| session_id | `session`；缺失时为合成值 `gateway:<requestId>`，合成值只用于明细与会话分组，不参与下述规则 A |
| timestamp | `ts`（UTC RFC3339，流结束时的记账时刻）换算为本机存储时区后的同一时刻，与扫描记录用同一时间轴比较；去重时另用开始时刻 `ts − latencyMs` |
| 项目 | 网关不知道工作目录，不猜测：带真实 session 时沿用该 `(tool, session_id)` 在本机项目索引（ADR-016）里的归属，否则归入「未归属」 |
| 成本 | 与扫描记录相同，按本机价格表以 (tool, model) 估价，不使用供应商账单 |

Token 口径：`inputTokens = input`（网关已扣除缓存读取的净输入），`outputTokens = output`，`cachedTokens = cacheRead + cacheWrite`，`cacheWriteTokens = cacheWrite`；有效 Token 仍为输入 + 输出，缓存读写单列，不得再并入。网关记录的读写拆分总是可证明的（两侧显式）。

**去重：重复时以网关记录为准。** 同一请求可能同时被网关记账、又被 Agent 自己的本地日志扫描到。合并时按下列顺序把重复的扫描记录标为「被网关取代」，被取代的扫描记录不进入任何统计（summary、tools、models、trends、heatmap、comparison、明细、facet 与实体看板），网关记录保留。每条网关记录覆盖区间 `[ts − latencyMs, ts]`（两端都换算为本机存储时间，截断到秒；开始晚于结束时按结束处理），窗口 `W = 5 秒` 加在区间两侧，依据见本节末尾。

1. **规则 A（会话跨度）**：对每个带真实 session 的 `(tool, session_id)` 网关分组，取其计入记录的最早开始与最晚结束 `[first, last]`；同 tool、同 session_id 且时间落在 `[first − W, last + W]` 内的扫描记录全部被取代。跨度内的扫描记录条数不必与网关记录相同（Agent 日志与 HTTP 请求不保证一一对应）。
2. **规则 B（指纹兜底）**：适用于没有真实 session 的网关记录，以及其 `(tool, session_id)` 分组在规则 A 下一条扫描记录都没取代的网关记录（例如 Codex 子代理线程：网关看到子线程 id，扫描侧记在根线程 id 下）。按 `ts` 升序（同刻按 `requestId` 字节序）逐条处理，每条网关记录最多取代一条尚未被取代的扫描记录：同 tool、`(inputTokens, outputTokens, cachedTokens)` 三者完全相等、且扫描时间到该网关区间的距离不超过 W（落在区间内距离为 0）；多条候选取距离最小者，再取扫描记录 `id` 最小者。指纹不等时不取代，两条都保留。
3. 其余情况不去重。扫描记录永远不会取代网关记录；T10.300a 增加可选 `logicalRequestId`：`requestId` 是上游尝试唯一身份，`logicalRequestId` 在失败转移期间保持一致。零Token诊断先排除，不占计费身份；成功按 `logicalRequestId ?? requestId` 唯一，失败但带用量的行按尝试 `requestId` 保留其计费记录。旧行无新字段仍可读，旧失败计费行用 `(requestId, provider, ts, status)` 区分，避免覆盖同ID成功行；重复轮转行不累计。统计的“记录数”因此不等于逻辑调用次数。

规则只在本机执行（本机看板合并与云端上传前的合并，见下），结果是派生的：不修改、不删除扫描入库的原始行，网关文件或扫描数据变化后整体重算。

**明细与能力声明（可选扩展）。** 本机明细 `items[]` 可带可选 `source: "scan" | "gateway"`，网关来源另带可选 `provider`；字段缺失按 `scan` 理解（旧生产者）。本机响应在合并生效时声明 `meta.capabilities.gatewayLedger = true`；缺失表示生产者未合并网关记录。读者遇到未知 `source` 取值时按未知来源显示，不丢弃该行。

**兼容与边界。**

- 网关记录不写入本机 `token_logs`；本机看板通过只读合并视图并入。云端见下文「云端合并上传」。
- 从未存在网关来源时维持纯扫描统计；持久库或旧来源存在但不可读时明确失败，不能静默退回纯扫描并覆盖云端。旧导入中的坏行计入不完整标记；越界或不可读保持待导入，原文件不轮转，新用量仍独立持久保存，修复后幂等恢复。
- 旧日志或云同步状态存在时，持久记录迁移 UTC 边界；开始时刻早于边界的本机小时（含迁移当小时）永久视为历史可能不完整，不因时间流逝变成完整。DST 重复小时按最早起点判定，不存在小时保守拒绝；本机可展示已找回记录，不将其宣称为完整历史。
- 同步对不完整小时的普通上传、网关合并、旧桶删除与回执均暂停；整工具清理保留待办，避免删除不可重建历史。新完整小时仍受原有会话、Codex 重建与数据库门禁约束。响应明确 `history_pending` 与 warning，已有云端历史保持不动；不自动补零、清空或推测已丢记录。
- **W 的依据（T10.273，U-96）**：本机存储时间截断到秒，网关记录的区间两端与扫描时间各可能少不到 1 秒，因此取 2 + 1 + 1 + 1 = 5 秒。按整个区间比较，不依赖 Agent 日志时间戳写在流开始还是结束。规则 B 在同 tool、同指纹、W 内多次请求时可能配错对象，但不改变合计。精确匹配需要上游请求 ID；本网关的 `requestId` 是本地随机 ID，暂不具备该条件，记下上游请求 ID 后另立任务补上。设计依据见 `docs/design/gateway-cloud-sync-v1.md`。

**云端合并上传（T10.273，可选扩展）。** 云端 `token_logs` 只存「设备 × 工具 × 模型 × 小时」聚合行，没有会话与逐请求数据，因此**去重在桌面客户端完成，RPC 不去重**（桌面各自上传本机已去重结果）：

- 受网关影响的小时 = 计入的网关记录所在小时 ∪ 被取代扫描记录所在小时。对这些小时，桌面按上述规则合并后重算该小时的全部聚合行：被取代的扫描行不计入，网关记录按维度映射计入；`unique_key = agg_<machine_id>_<tool>_<model>_<小时>` 与扫描聚合同一格式，上传时 upsert。合并后已不存在的旧键（上次上传过、或按纯扫描口径会产生的键）从云端删除。其余小时仍按纯扫描口径上传，行为不变。
- 聚合行新增可选列 `gateway_requests`：该行 `requests` 中来自网关记录的条数，满足 `0 ≤ gateway_requests ≤ requests`。新客户端对纯扫描聚合写 0；`null` 表示旧客户端上传、来源未知。它只用于来源审计，RPC 与 StatsData 不读取，不改变任何字段的口径。
- 不上传会话 ID、`requestId`、`provider`、key、本地 token、请求或回复内容；云端收到的仍只是小时聚合，因此无需哈希会话。网关记录的成本按上传时本机价格表估算并冻结，与扫描行一致（DESIGN §2.5）。
- 增量与重试：桌面在 `app_data/gateway/cloud-sync-v1.json` 记录每个受影响小时上次上传的聚合指纹（不含成本）与键；指纹变化或该小时有待同步扫描行时才重传，全部 upsert 与删除成功后才写状态与扫描行同步标记，中途失败下次整体重算。upsert 与按键删除都可重复执行。
- 兼容：所有 v1/v2 RPC 对聚合行求和，签名与响应形状不变，Android 与旧桌面读到的数字自动包含已合并的网关记录。旧云端缺 `gateway_requests` 列时桌面去掉该字段重试；旧桌面不发送该列（为 `null`），也不上传网关记录。云端不声明 `gatewayLedger`：是否合并取决于各设备上传时的客户端版本，同一账号混用新旧桌面时，旧桌面上传的小时仍是纯扫描口径。
- 迁移 `20261004120000_gateway_aggregate_provenance.sql` 增加上述列与约束，并让物化视图脏标记触发器覆盖 `DELETE`（只删不插的同步也要刷新汇总）。RLS 沿用 `token_logs` 按 `auth.uid() = user_id` 的四条策略。

共享 fixture `gateway-dedupe-v2.json` 锁定上述映射、区间与窗口、两条规则、零 Token 失败请求与合并后的有效 Token 合计。

## 3. comparison

```json
{
  "window": {
    "kind": "dayOverDay",
    "timezone": "Asia/Shanghai",
    "bucket": "hour",
    "currentStart": "2026-07-14T00:00:00+08:00",
    "currentEnd": "2026-07-14T09:30:00+08:00",
    "previousStart": "2026-07-13T00:00:00+08:00",
    "previousEnd": "2026-07-13T09:30:00+08:00",
    "alignedThrough": "09:30"
  },
  "current": {
    "summary": {},
    "series": [{ "bucket": "00:00", "tokens": 1200, "requests": 3, "cost": 0.12 }]
  },
  "previous": {
    "summary": {},
    "series": [{ "bucket": "00:00", "tokens": 800, "requests": 2, "cost": 0.08 }]
  },
  "delta": {
    "tokens": { "absolute": 400, "percent": 50.0, "direction": "up" },
    "requests": { "absolute": 1, "percent": 50.0, "direction": "up" },
    "cost": { "absolute": 0.04, "percent": 50.0, "direction": "up" }
  }
}
```

`direction`: `up | down | flat | new`；基期为 0 且当前大于 0 时为 `new`、percent=null。

`window.kind` 取值 `dayOverDay | weekOverWeek | monthOverMonth | periodOverPeriod`。`periodOverPeriod` 只随 `range = custom`（T10.108）出现：当前窗口是用户指定的本地日期闭区间（`start 00:00:00` 到 `end 23:59:59`，跨越“现在”时截到现在），上一窗口是紧邻其前、等长的区间，并与预设范围一样按同一进度对齐；单日区间 `bucket = hour`，其余 `day`。旧读者遇到未知 kind 时按“无自动基线”处理，不得当作 dayOverDay。

`current.series` 与 `previous.series` 必须从各自窗口起点到同进度截止点生成同长度、同顺序的稠密桶；没有消耗的已开始小时/日期用 0 填充。客户端可据此计算“小时桶/日桶均值”，但不得把包含未结束末桶的均值表述为完整小时速率。

## 4. 查询上下文

```json
{
  "range": "today",
  "timezone": "Asia/Shanghai",
  "machines": ["macbook-pro", "studio-pc"],
  "tools": ["claude", "codex"],
  "models": ["gpt-5-codex"],
  "search": "session-42",
  "tokenMode": "effective"
}
```

同一维度内是 OR，不同维度间是 AND；空数组表示不限制该维度。云端 RPC 必须校验 `auth.uid()`，本地命令只读当前应用数据库。`meta.query` 只回显规范化后的 canonical 上下文，供 UI 判断响应、缓存和游标是否仍匹配当前选择。

`range` 取值 `today | week | month | year | all | custom`。`custom`（T10.108）必须同时携带 `start` 与 `end`（本地 `YYYY-MM-DD` 闭区间，`start ≤ end`，最长 731 天）；二者是查询身份的一部分，进入 canonical 上下文、`meta.query` 回显、缓存指纹与 v2 cursor。预设范围不携带这两个字段，规范化时一律丢弃。自 T10.113 迁移 `20260905162953_android_custom_date_ranges.sql` 起，四个云端 v2 RPC 支持相同 custom 查询，Android 已接入；开始日期不得晚于所请求时区的今天，未来结束截到请求时刻，单日用小时桶，其余用日桶，同期取前方等长日期区间并按同一进度截止。custom 热力图从 start 起至有效 end 截止，预设范围仍提供全年热力图。桌面（T10.185 起）与 Android 的云端 scope 都把 `start/end` 随查询发给对应 v2 RPC。尚未部署迁移的云端若缺少 v2 签名，或以 HTTP 400、SQLSTATE `22023`、`query-v2: invalid range custom` 明确拒绝 custom，两端都显示能力不可用（桌面文案为「云端范围受限」），禁止退回预设、丢弃日期或显示 0。所有旧入口降级规则均只适用于预设范围。

### 4.1 规范化与预算

1. `machines/tools/models` 每个数组最多 32 项；每项只去除首尾 `U+0009 TAB`、`U+000A LF`、`U+000D CR`、`U+0020 SPACE`，之后必须非空且不超过 256 UTF-8 bytes。其他 Unicode whitespace 不自动删除。
2. 值按 unsigned UTF-8 bytes 字典序升序排序并精确去重，不做 Unicode normalization 或大小写折叠，避免改变供应商/设备原始 ID。
3. `machines` 不允许 `all` 或 `all_cloud`；它们只在旧 machine 单值入口等价为空数组。
4. `search` 使用与数组元素相同的四字符 ASCII trim；缺失、null 或 trim 后空串统一为 null，非空时最长 256 UTF-8 bytes。
5. search 只覆盖 `tool/model/machine_id/session_id`。查询全为 ASCII 时做 ASCII 大小写不敏感的字面子串匹配；含非 ASCII 时做大小写敏感字面子串匹配。`%`、`_` 和反斜线没有 SQL 通配符语义，必须绑定参数并按目标数据库规则转义。
6. 任何超限、错误类型、空元素、非法 machine 哨兵或 plural/singular 冲突都拒绝整个请求；不能截断、clamp 或返回部分筛选。

### 4.2 旧单值兼容

`machine/tool/model` 是兼容输入别名，不再由新请求生产者发送。plural 缺失时，旧非空单值转为单元素数组；旧 machine 的 `all/all_cloud` 转为空数组。plural 与 singular 同时存在时，规范化后的集合必须等价，否则请求失败。

v2 响应保持 additive：新读者必须继续接受旧云端的 singular-only `meta.query` 并内部转为数组；新响应总是产生 plural。对应数组为空时 singular 兼容 echo 固定为 null，只有一项时 echo 该值，多项时 singular 字段缺失。若同一响应双写不等价，客户端把 query echo 判为 malformed，不能猜测。

云端新增独立 v2 RPC 名称或 `p_query jsonb` 参数，保留旧 `_v1` 签名。新 RPC 尚未部署时只按下表无损降级；超出对应 endpoint 表达能力就返回 capability unavailable，不能去掉筛选或只筛当前页。

| Surface | 旧入口 | 允许降级的 canonical query |
|---|---|---|
| 主看板 | `get_dashboard_stats` | machines 0/1 项；tools/models 为空；search=null |
| 同期比较 | `get_usage_comparison_v1` | machines/tools/models 各 0/1 项；search=null |
| 明细 | `get_usage_details_v1` | machines/tools/models 各 0/1 项；search=null |
| 实体看板 | `get_usage_entity_dashboard_v1` | model entity 可带 0/1 tool 与 0/1 machine；tool entity 只可带 0/1 machine 且 models 为空；search=null |

### 4.3 实体请求

新实体请求把 selector 与查询上下文分开：

```json
{
  "entity": { "kind": "model", "id": "gpt-5-codex" },
  "query": {
    "range": "month",
    "timezone": "Asia/Shanghai",
    "machines": ["studio-pc"],
    "tools": ["codex"],
    "models": [],
    "search": null,
    "tokenMode": "effective"
  }
}
```

`entity.kind` 只能是 `tool|model`，`id` 使用数组元素的 ASCII trim、非空与 256 UTF-8 bytes 预算，不做大小写折叠或 Unicode normalization。与实体相同维度的查询数组必须为空；其他维度继续作为组合上下文。旧 `tool+model` 兼容为 model selector + tool 查询上下文，单独 tool/model 兼容为对应 selector。

实体看板的完整请求身份是 `canonical query + entity.kind + normalized entity.id`。该身份必须同时绑定缓存键、latest-wins/取消身份、响应 `meta.entity` echo 与实体明细游标；响应缺失或 echo 不匹配时判为 malformed，不能仅按 query 接受迟到响应。普通看板响应不产生 `meta.entity`。

### 4.4 实体设备组成（T10.137a，可选兼容扩展）

`composition.machines[]` 按实体选择器与完整 canonical query 的非空设备聚合，字段为 `value/tokens/inputTokens/outputTokens/cachedTokens/requests/cost`。其中 `tokens = inputTokens + outputTokens`，`cachedTokens` 保持原始 combined 缓存口径（`sum(token_logs.cached_tokens)`），不再次加 `cache_write_tokens`，也不并入有效 Token。本扩展不新增可证明的缓存读写拆分，不因缺少provenance伪造拆分值。

云端迁移 `20260909074317_entity_machine_token_components.sql` 只给已有机器条目补充输入、输出和combined缓存三字段；不改变RPC参数、筛选、顺序、权限与旧v1签名。旧云端缺少input/output时，Android显示“不可得”；显式双侧0仍为真实0。空实体保留空数组。TypeScript CompositionItem/Rust本地生产者已有这些数值字段，Kotlin已支持新字段并保持旧缓存缺失状态，无需改变字段类型。

## 5. 明细分页

```json
{
  "items": [],
  "nextCursor": "opaque-or-null",
  "totalCount": 1254,
  "filteredSummary": {},
  "availableFilters": {
    "tools": [{ "value": "codex", "count": 900 }],
    "models": [{ "value": "gpt-5.4", "count": 600 }],
    "machines": [{ "value": "macbook-pro", "count": 700 }]
  }
}
```

游标必须稳定排序到 `(timestamp DESC, id DESC)`。v2 opaque cursor 同时绑定 canonical query（不含 cursor/limit）的确定性指纹；实体明细再绑定 `entity.kind + entity.id`。服务端解码后校验指纹，不匹配就拒绝，不能把旧位置静默套到新筛选。旧 cursor 编码只由旧 RPC 继续接受。客户端不得对最近 200 条预览做过滤后声称是完整筛选结果。

`filteredSummary`、items、totalCount 与 facet 必须来自同一数据库快照和同一 canonical query。计算某维 facet 时只移除自身数组，保留其余数组与 search；例如 model facet 忽略 `models[]`，但继续应用 machines、tools 与 search。筛选或 search 变化后旧游标立即失效，不能跨 query 复用。

## 6. meta 与 capabilities

```json
{
  "contractVersion": 2,
  "generatedAt": "2026-07-14T09:30:00+08:00",
  "lastRefreshedAt": "2026-07-14T09:29:40+08:00",
  "timezone": "Asia/Shanghai",
  "range": "today",
  "machine": null,
  "stale": false,
  "capabilities": {
    "cacheSavings": true,
    "comparison": true,
    "detailPagination": true,
    "entityDashboard": true,
    "multiFilterSearch": true,
    "quotaSnapshots": false
  }
}
```

v1 无 `meta.contractVersion` 时，客户端按 `1` 处理并关闭依赖 v2 的入口或本地降级计算。

`cacheSavings=true` 表示生产者按 §2.4 计算；为 true 而 summary 缺对象时，该范围的缓存节省不可得。

`gatewayLedger=true`（可选，仅本机生产者）表示本次响应已按 §2.5 并入网关记录并执行去重；缺失表示纯扫描口径。云端不声明此能力：云端聚合是否已合并网关记录取决于各设备上传时的客户端版本（§2.5「云端合并上传」）。

`meta.range = custom` 时 `meta.query.start/end` 必然存在，且本地响应的 `capabilities.comparison` 为 true（自定义区间总带 `periodOverPeriod` 对比）。

`multiFilterSearch=true` 只在主看板、同期比较、明细、实体看板、query echo、缓存键与 v2 cursor 全部接受同一 canonical query 时声明；任一 surface 仍是单值或不支持 search 时必须为 false/缺失。不能用单个新 RPC 冒充整条事实链完成。

## 7. 演进规则

1. v2 内可新增可选字段；删除、改名、改变类型或统计语义必须升级版本。
2. Supabase 先新增明确命名的 v2 RPC/参数并保留旧签名，桌面与 Android 再启用；兼容入口退出必须另立任务，不能用 PostgREST 重载默认参数制造歧义。
3. 每次演进提供最小 fixture、旧版 fixture、时区/边界 fixture 和权限测试。
4. schema/RPC 变化必须写新 migration、回归、README、TypeScript/Kotlin/Rust 类型和任务日志。`supabase/migrations/` 是多人协作与新环境的唯一事实源；`schema.sql` 是停在 2026-06 v2 基线、禁止直接执行的历史快照（见其文件头），不能替代迁移链。

## 8. 共享 fixture 与兼容别名

唯一 fixture 根目录为 `fixtures/dashboard-stats-v2/`，TypeScript、Kotlin 与 Rust
测试必须直接读取这里的同一份文件，不在各端复制 JSON：

| fixture | 锁定行为 |
|---|---|
| `legacy-v1.json` | 无 `meta.contractVersion` 时按 v1 关闭 v2 能力 |
| `complete-v2.json` | 完整 v2、`historyPage`、从窗口起点补零的稠密同进度序列、IANA 时区与能力声明 |
| `missing-optionals-v2.json` | 可选字段缺失时安全降级，不把未知值伪装成 0 能力 |
| `unknown-fields-v2.json` | 新增顶层、meta、capability 字段时旧客户端继续解析已知字段 |
| `unknown-cost-cache-provenance-v2.json` | 真实零成本与未知成本保持可区分；缓存拆分只有双侧显式且与合计一致时成立，缺失或不一致时降级为 combined |
| `multi-filter-search-query-v2.json` | ASCII trim、空元素拒绝、精确去重、unsigned UTF-8 排序、search 字面命中矩阵与 entity selector 分离 |
| `daily-costs-v2.json` | 同query/月范围/可信时区的完整正有限日金额，以及跨端保留 |
| `daily-costs-unavailable-v2.json` | 历史零、缺值、非法值日不可得，不拿部分金额冒总额 |
| `legacy-single-query-v2.json` | 旧单值转换、`all_cloud` 空数组语义、等价双写与冲突拒绝 |
| `cache-savings-v2.json` | `summary.cacheSavings` 的合法形状：列价正值、兜底计数、负净值、已知 0、微小值与云端 `uploaded-prices` 形状（未知附加键忽略）；`rows` 与 `prices` 供本机生产端复算 |
| `cache-savings-invalid-v2.json` | 拆分不可证明时对象缺失；非法形状整体丢弃而核心字段（含 `cacheSavedUsd`）保留 |
| `gateway-dedupe-v2.json` | §2.5 网关记录映射、`[ts − latencyMs, ts]` 区间与 5 秒窗口、规则 A 会话跨度、规则 B 指纹一对一兜底、零 Token 失败请求不计入，以及合并后的取代集合与有效 Token 合计 |

网络与跨端持久契约只产生 `historyPage` 和 `meta.capabilities.detailPagination`。
Android 为读取旧本地缓存可兼容顶层 `detailsPage`、`capabilities.details`；这些别名
不得由新的服务端或桌面端响应继续产生。

### Android 全局热力图呈现（T10.136）

全局热力图不改变上述wire契约。preset利用可信年度heatmap，custom如需年度背景可另取年度查询，使用独立请求身份和缓存；辅助响应只供热力图，不合并summary/models/dailyCosts。选中范围只做高亮，单日复盘仍使用规范单日查询。每日金额不得从全局底图反推或借用其他响应。

## 9. 版本记录

v2 内的只增扩展逐条记在这里；`meta.contractVersion` 只在 §7 第 1 条所说的不兼容变化时升级。

- 2026-09-25 T10.183（T10.162 A1）：新增 §2.4 `summary.cacheSavings` 与 `meta.capabilities.cacheSavings`；`cacheSavedUsd` 语义不变；`contractVersion` 仍为 2。
- 2026-09-25 root（T10.183 评审 P3-4、决定 R-22、R-26、R-27）：§2.4 措辞修正（出现条件、三处代码路径）、声明能力的 RPC 须保留 `cacheSavedUsd`、`cacheSavedUsd` 非法时丢弃对象；§6 能力示例与 §8 fixture 表补 `cacheSavings`。语义不变。
- 2026-09-25 root（T10.184、T10.185）：§4 桌面云端 scope 已接通 custom（T10.185），旧云端识别条件与 Android 相同；共享非法夹具 `cache-savings-invalid-v2.json` 补「兜底计数为字符串」「`cachedTokens` 为小数」两例（T10.184 评审 P2-1），Android 与桌面同样整体丢弃。语义不变。
- 2026-10-04 T10.264（U-95、ADR-017）：新增 §2.5 网关记录来源与去重（规则 A 会话跨度、规则 B 指纹兜底，`W = 120 秒` 待用户确认）、明细可选 `source`/`provider` 与 `meta.capabilities.gatewayLedger`；本期只进本机看板，云端与 Android 不变；`contractVersion` 仍为 2。
- 2026-10-04 T10.273（U-96）：§2.5 窗口由 120 秒改为 5 秒，并改为对网关记录的 `[ts − latencyMs, ts]` 区间比较；新增「云端合并上传」：桌面合并去重后上传小时聚合，聚合行可选 `gateway_requests` 列，RPC 签名与响应不变，云端不声明 `gatewayLedger`；`contractVersion` 仍为 2。
