# TokenLedger

TokenLedger 是一款基于 **Tauri 2 + React + Rust** 的跨平台 AI 工具 Token 消耗监控桌面应用。应用会扫描本地多种 AI 辅助工具的日志与数据库，把 Token 使用量、记录数和预估费用汇总到本地 SQLite 看板，并可选同步到 Supabase 以支持多设备聚合。

面向 macOS arm64、Windows x64 与 Android API 26+。Linux 保留源码构建能力，但暂不在支持声明内。

## 安装

发行包见 [Releases](https://github.com/Geidorf/TokenLedger-open/releases)。Linux x64 有未签名的 AppImage、deb 与 rpm 预览包（仍不在支持声明内，安装方法见用户手册），也可以从源码构建，步骤见下方「从源码构建」。

安装步骤（含未签名安装包在 Windows 与 macOS 上的放行方法、Linux 的托盘与自启说明）、各页面说明、云端同步与手机端、隐私说明和常见问题见**用户手册**。已部署版本：[在线用户手册](https://geidorf.github.io/TokenLedger-open/)；源码文档：[中文](docs/guide/zh/README.md) · [English](docs/guide/en/README.md)。

## 从源码构建

需要 Node.js 22+、Rust 1.96+；构建 Android APK 另需 Android SDK 与 JDK 17。

```bash
git clone https://github.com/Geidorf/TokenLedger-open.git
cd TokenLedger
npm install
npm run tauri build      # 桌面安装包
```

详细步骤、平台依赖与常见问题见 [CONTRIBUTING.md](CONTRIBUTING.md)。

---

## 核心功能

- **本地日志扫描**：内置多种 AI 工具解析器，当前主线覆盖 Claude、Codex、OpenCode、Kilo、AntGravity、MiniMax/Marvis、腾讯 Marvis、WorkBuddy、Qclaw、Hermes、ReasoniX、Trae、DeepSeek GUI、DeepSeek 官方 DSH、Zcode、Grok CLI、Gemini CLI、Kimi Code/Desktop、Pi（含 Multica Desktop 托管实例）、Cindy 内置的 Codex 与 Pi、Qwen Code、GitHub Copilot CLI、Cline / Roo Code / Kilo Code 扩展、goose 等工具。
- **本地 SQLite 存储**：扫描结果写入应用数据目录下的 `tokenboard.db`，本地查询响应快，也可离线使用。
- **可解释数据看板**：React 19 + ECharts + Tailwind 4，展示有效 Token、预估费用、缓存、工具/模型分布、年度热力图和逐条记录明细；今日/本周/本月按同一进度自动对比上一周期。
- **筛选与专属看板**：明细可按工具、模型、设备组合筛选并稳定分页；工具/模型排行可下钻到专属趋势、构成、设备、活跃度和相关明细。
- **诚实额度中心**：Codex 使用官方 `app-server`，Claude 使用 status line 或内置 `/usage` PTY，Antigravity 使用内置 App/IDE/`agy` loopback；用户另行安装的 CodexBar 只作为 Claude/Antigravity 的可选本地兜底，因此 Windows 没有 CodexBar 也能使用主路径。所有来源逐项授权、异步复核，只保留白名单额度窗口；不抓 Cookie、不复用 OAuth Token、不调用私有消费者端点。跨设备同步按账户与 Provider 持久保留最新可用快照，以来源 `observedAt` 决胜，关闭某台设备或退出登录不删除云端历史；只有显式 Provider/全局删除会写入防迟到写的墓碑。很久以前的快照仍可读取，并按真实观测时间标记 stale。完整安全边界见 [额度 Provider 能力矩阵](docs/integrations/quota-provider-capabilities.md) 与 [额度同步契约](docs/contracts/quota-provider-v1.md)。
- **Supabase 云同步**：可选把本地聚合数据同步到 Supabase，支持云端视图、设备筛选和多设备汇总。 实体设备输入/输出/combined缓存字段补齐迁移见 `supabase/migrations/20260909074317_entity_machine_token_components.sql`；缺字段旧云端仍显示不可得，详见 [统计契约](docs/contracts/dashboard-stats-v2.md#44-实体设备组成t10137a可选兼容扩展)。
- **现代 Android 看板**：原生 Compose + Material 3 的 Ledger Snapshot，支持同期趋势、筛选、实体下钻、离线快照和深色/浅色/E-ink 骨架；手机使用底部导航，`>=600dp` 宽屏使用 NavigationRail，320/390/430dp、字体 200%、E-ink 与 840dp 平板六状态有主机截图回归。
- **桌面/锁屏壁纸**：基于本地或云端统计生成动态壁纸；Windows 支持桌面和锁屏，macOS/Linux 当前仅提供桌面相关能力或占位实现。
- **命令行工具**：`tokenledger-cli` 查看今日/本周/本月用量（可按 Agent、模型、账号拆分）、额度剩余、预算状态、网关状态与最近路由，触发扫描，导出 CSV/JSON；每个命令都有表格与 `--json` 输出，便于脚本和状态栏插件调用。数字与桌面端同一套 Rust 实现，见 [命令行文档](docs/cli.md)。
- **本机 MCP 服务**：`tokenledger-cli mcp` 以 stdio 方式给 Claude Code、Codex 等 Agent 提供只读工具（今日/本周用量与拆分、额度剩余、预算、网关健康与最近路由、用量异常）和额度紧张时自我节制的提示词；不监听端口，不输出密钥与请求内容，见 [MCP 文档](docs/mcp.md)。
- **系统托盘**：支持最小化到托盘、托盘显示主窗口、安全退出，以及启动时最小化；当启动配置使窗口默认驻留托盘时，可用 `--show` 显式恢复主窗口。
- **VS Code 状态栏插件**：`extensions/vscode/` 在编辑器状态栏显示今日预估费用或最紧额度的可用%，悬停看额度条、今日拆分、预算与网关健康；数字全部来自本机命令行 `tokenledger-cli`，不读密钥、不联网。打成 .vsix 手动安装，不上架市场，见 [插件说明](extensions/vscode/README.md)。
- **价格配置**：可在设置页维护模型输入/输出 Token 单价，保存后后续扫描立即使用。
- **新模型自动发现**：本地日志出现未匹配的模型 ID 时，价格表会自动增加“待核价”项，以当前工具兜底费率暂估；待核价行可按原始模型 ID 搜索 models.dev，选择具体供应商的报价并一键导入。日期快照复用已有模型族，模式名、占位符和异常文本不会进入价格表。

内置价格的单位、近期模型来源和短/长上下文限制见 [MODEL_PRICING.md](MODEL_PRICING.md)。

---

## 扫描工具 Token 口径基准

当前桌面主线扫描器位于 `src-tauri/src/scanner/`（`runner.rs` 调度，各工具解析器按文件拆分）。本节记录每个扫描工具的 Token 字段来源、归一化规则和去重边界，作为后续重构时防止扫描逻辑漂移的基准。旧版 Node.js + Python 扫描器源码已删除，不代表当前主线口径。

### 全局落库规则

- 所有扫描结果都会归一为 `tool`、`model`、`input_tokens`、`output_tokens`、`cached_tokens`、`cache_write_tokens`、`timestamp`、`session_id`、`unique_key`、`cost_usd`。
- `cached_tokens` 是「缓存读 + 写」合计；`cache_write_tokens` 单独记录写入份额。无法区分读写的工具 `cache_write_tokens` 记 0，成本估算时整段缓存按读价计。
- **有效 Token（effective tokens）= `input_tokens + output_tokens`** 是看板主口径（总量、趋势、热力图、工具/模型排行）。缓存量不计入有效 Token，仅作为独立指标（缓存读/写、缓存净节省；现行界面的「缓存节省」仍是读取节省，分期见 `docs/design/cache-savings-net-v1.md`）展示，避免缓存把总量放大几十倍。
- 成本估算按 `prices.json`：输入按 `input`，输出按 `output`，缓存读按 `cache_input`（缺省为 `input × 0.1`），缓存写按 `cache_write`（缺省为 `input × 1.25`）。Codex 与 Zcode 扫描时已把来源中含缓存的输入归一成新鲜输入（Zcode 自 schema v10 起），成本按净输入直算。缓存读写均按各自价格另计。
- `timestamp` 统一通过 `normalize_timestamp` 转成本地时间 `YYYY-MM-DD HH:MM:SS`；数字时间戳大于 `1e11` 时按毫秒处理，否则按秒处理。
- `unique_key` 是本地去重边界，普通不可变记录写入 `token_logs` 时使用 `INSERT OR IGNORE`。Claude 的同一消息会产生递增流式快照，因此只允许更完整的输出/输入缓存快照原位修正旧行并重新排队同步；较小快照和普通重复扫描不会覆盖已有行。
- Claude JSONL、Codex rollout、Antigravity transcript、WorkBuddy project、Trae、DeepSeek GUI、DSH zstd 会话、Kimi wire 和 Pi 会话使用版本化持久检查点跳过指纹完全一致的历史文件；任何追加、截断、替换或 mtime 变化都会安全重扫该文件，并让 Token 行与检查点在同一个 SQLite transaction 提交。进程内会复用已经验证且大小/mtime 未变的文件身份，避免 Windows 每轮为大量历史文件重复打开句柄。
- OpenCode/Kilo 按有索引的文本主键增量读取，并保留最近 512 行可变尾部以捕获流式原位更新；MiniMaxCode v2/旧库和腾讯 Marvis 按整数主键增量读取。Provider 游标与 Token 行原子提交，数据库替换或解析器版本变化会使旧游标失效。
- 正在使用的来源 SQLite 必须由桌面端当前平台的原生 SQLite 以普通只读事务读取，使查询自动合并已提交但尚未 checkpoint 的 WAL 帧；禁止对实时库使用 `immutable=1`，因为它会忽略 `-wal` 中的新记录。MiniMaxCode v2 使用该路径并设置 5 秒 busy timeout。
- **来源文件的大小与数值边界（所有扫描器共用）**：JSONL 逐行读取时，坏 UTF-8 字节按替换字符保留整行，首行 BOM 和崩溃留下的行首、行尾 NUL 填充会去掉；单行超过 32 MiB 时整行跳过且不读进内存（这种行只会是内嵌附件或失控的工具输出，不带用量），行号照常计数，按行号拼的去重键不会错位；读到 IO 错误即停止读这个文件。整份读取的旧版 Gemini 单 JSON 会话超过 256 MiB 时不扫描；Grok `summary.json`、ReasoniX meta 与配置、DeepSeek GUI 设置等附属文件超过 4 MiB 时忽略。写库前统一清洗：负数计数记为 0；任一计数超过 1 万亿（10¹²）的行视为损坏，整行丢弃，否则会让看板的 `SUM()` 整数溢出；非有限、为负或超过 100 万美元的来源费用记为 NULL，交给价格表重算。时间戳会进入去重键的来源（如 Grok），时间戳无法解析时跳过该行，不用扫描时刻兜底，否则每次扫描都会重复入账。
- **累计型来源（Hermes、ReasoniX）** 的会话行会原地增长。这类记录标记为 `cumulative`，落库时通过独立累计状态表以 O(1) 求增量后写入带 `#t...` 后缀的增量行；旧数据库首次遇到该来源时只做一次历史聚合用于迁移，之后不再扫描整表。来源回退（总量变小）时不写入增量行，但会把累计基线重置到新值——否则来源重置后的所有增长都会被旧高水位吞掉。累计费用同理只采信真实增长：来源费用持平或回退时该增量行的 `cost_usd` 记为 NULL 交给价格表重算，而不是记成 0（0 是非 NULL，永远不会再被重算）。
- 自动扫描默认每 900 秒执行一次，旧版恰为 60 秒的默认配置会一次性迁移到 900 秒，用户可配置下限为 60 秒。无新增记录时不启动常规云同步；失败重试最多每 15 分钟一次，成本回填只更新受影响行，不再重置整张 `token_logs`。
- `machine_id` 写入本机随机设备 ID（应用数据目录的 `device-id`，旧版本写的主机名在升级时迁移），`sync_status` 初始为 `0`，后续云同步再更新状态。
- 新增或修改扫描器时，必须同步更新本节的来源、Token 字段、跳过条件和去重键。

### 数据库迁移（当前 schema v16）

- `token_logs` 新增 `cache_write_tokens` 列，并新增 `(timestamp)`、`(tool, timestamp)` 索引加速统计聚合。
- `PRAGMA user_version` 升到 2 时，会删除旧版按内容块重复计数的 `tool='claude'` 历史行（下次扫描按新去重键重建），并向 `pending_cloud_purges` 写入一次性云端清理标记，由下次云同步删除云端对应的旧聚合行后再按修正口径重推。
- `PRAGMA user_version` 升到 4 时，会把 Claude、Codex、Trae、Zcode 这类没有供应商原始成本的历史估算值清空并标为待同步；Token 原始记录不会删除，后续看板/同步会按新版价格与缓存公式重新估算。其他工具提供的原始 `cost_usd` 保持不变。
- `PRAGMA user_version` 升到 5 时，会把本地历史模型索引到独立的 `discovered_models` 目录；该目录与官方默认价、用户价格覆盖分离，用于持续生成可编辑的“待核价”配置项。
- 早期 `PRAGMA user_version = 6` 迁移曾直接删除并重扫 `tool='codex'` 的旧记录；当前升级链不再执行这段破坏性操作，而是把修复交给 v9 的分阶段重建。
- `PRAGMA user_version` 升到 9 时，如检测到旧 Codex 行或检查点，只写入一条“尚未就绪”的重建标记，旧账本、缓存与云端数据保持可用。扫描器完整解析 `sessions` 与 `archived_sessions` 后，才在同一事务内按可重建的 session 精确替换旧行、写入 v2 检查点并开放云端清理；任一文件缺失父任务、解析失败或扫描期间变化都会整体推迟替换。没有源文件的孤立历史行会保留，并在整机云端 Codex 聚合清理后重新上传；其他工具和其他机器的数据不受影响。
- `PRAGMA user_version` 升到 10 时，会删除含缓存读的毛输入 `tool='zcode'` 历史行（实测有效 Token 虚高约 58 倍），并写入一次性云端清理标记；下次全量扫描按净输入口径重建，云同步在清理后重推修正行。其他工具与其他机器的数据不受影响。
- `PRAGMA user_version` 升到 11 时，会把旧版 MiniMax Code 误造的 `mavis-*` 模型标签就地改为 `tool='minimax'`、`model='minimax-unknown'`，保留 Token 数值并标记待同步，不影响其他 Marvis 真实模型。
- `PRAGMA user_version` 升到 12 时，会删除按旧口径写入的 `tool='gemini'` 历史行与 `gemini-cli-chats-v1` 检查点，写入一次性云端清理标记并由 `gemini-cli-chats-v2` 重新扫描官方 `prompt/cache/thoughts/total` 口径。若本机已没有原始 Gemini 会话文件，旧行不会伪造恢复；其他工具与其他机器的数据不受影响。
- `PRAGMA user_version` 升到 13 时，只新建本机项目维度的两张空表 `local_session_projects` 与 `local_project_index_state`（项目维度默认关闭，见下文“项目维度”），不回填，不改 `token_logs`、去重键、检查点与游标，也不写云端清理标记；这两张表不参与云同步。降级到不认识 v13 的旧版前，如已开启“按项目统计”，先在设置中关闭：旧版会忽略这两张表，无法关闭或清除，重新升级后会按原授权继续采集。即使以后回退本功能，编号 13 也不得复用。
- schema v14 增加仅本机使用的 `token_logs.sync_revision` 和修订触发器。扫描修正、金额回填/重计价及同步重置会推进修订；上传成功只确认实际上传的修订，新改动仍待同步。迁移保留账本行与聚合键，不改变 Stats v2 或云端结构；编号 14 不得复用。回退前备份数据库，旧写入由触发器继续保护，但旧版本的上传确认不具备修订校验，应暂停旧版云同步。
- schema v15 给累计型来源状态表 `scan_cumulative_state` 增加 `generation` 列，来源重置时推进代数；并新增仅本机使用的 `scan_cloud_sent_identities`、`scan_cloud_dirty_buckets`，记录已上传的扫描身份与待重推的小时桶。迁移不删除账本行，编号 15 不得复用。
- schema v16 给 `token_logs` 增加 `usage_provenance`（`reported`/`estimated`）与 `cache_write_known` 两列，目前只有 Antigravity 写入：旧版 Antigravity 行标为 `estimated`、`cache_write_known = 0` 并重新排队同步，同时清空本地统计缓存。`cache_write_known = 0` 表示缓存写入未知，看板与云端不得把它当作 0；编号 16 不得复用。

### 当前扫描顺序

扫描顺序会影响重复数据规避逻辑，当前顺序如下：

1. Claude
2. Codex
3. OpenCode
4. Kilo
5. AntGravity
6. MiniMaxCode v2 runtime 与 MiniMax/Marvis 旧库
7. 腾讯 Marvis
8. WorkBuddy
9. Qclaw
10. Hermes
11. ReasoniX
12. Trae
13. DeepSeek GUI
14. DeepSeek 官方 DSH
15. Grok CLI
16. Gemini CLI
17. Zcode
18. Kimi Code
19. Kimi Desktop
20. Pi
21. Qwen Code
22. GitHub Copilot CLI
23. Cline / Roo Code / Kilo Code
24. goose

### 数据源与去重边界

| 工具 | 数据源 | 记录条件或粒度 | `session_id` | `unique_key` |
| --- | --- | --- | --- | --- |
| Claude | Claude Code `~/.claude/projects/**/*.jsonl`；macOS `~/Library/Application Support/{Claude,Claude-3p}/local-agent-mode-sessions/**/*.jsonl`；Windows `%APPDATA%`/`%LOCALAPPDATA%` 同名目录及 `%LOCALAPPDATA%/Packages/Claude_*/LocalCache/Roaming/{Claude,Claude-3p}/local-agent-mode-sessions/**/*.jsonl`；Linux/XDG 同名 best-effort 目录 | `type == "assistant"` 且 `message.usage` 存在；所有已变化文件跨 CLI/Desktop/Cowork 根目录共用一次去重，未变化文件按 `claude-jsonl-v2` checkpoint 跳过 | 文件名 stem | `claude_{message.id}_{requestId}`；全局取最完整流式快照，后续更完整快照条件更新原行。无 `message.id` 的旧日志回退 `claude_{session_id}_{uuid或line_行号}` |
| Codex | `~/.codex/sessions/**/rollout-*.jsonl` 与 `~/.codex/archived_sessions/rollout-*.jsonl`；以及 Multica Desktop 的任务级 `~/multica_workspaces_*/<workspace>/<task>/codex-home/{sessions,archived_sessions}/**/rollout-*.jsonl`（见下方 Multica 说明）；Cindy 桌面端的 `<userData>/codex-home` 与按账号分开的 `<userData>/codex-accounts/<owner>/<provider>`（见下方 Cindy 说明）；设置「扫描与启动」里填写的额外目录 | `type == "event_msg"` 且 `payload.type == "token_count"`；优先采用逐请求 `last_token_usage`，缺失时才对累计值求高水位增量；同计数 lane 最近一次或全局紧邻的完整 `total + last` 签名重复置零；fork/subagent 中与父任务截至分叉时刻匹配的有序回放前缀只恢复基线、不出账 | 文件名尾部 UUID，并与首个 `session_meta.payload.id` 交叉校验 | `codex_v2_{root_thread_uuid}_{非零事件序号}`；序号在文件内重复归零后、父回放过滤前分配，活动文件移入归档仍保持幂等 |
| OpenCode | `$XDG_DATA_HOME/opencode/opencode.db`（缺省 `~/.local/share`）的 `message` 表 | `data.tokens` 存在，且三类 Token 不全为 0 | `message.session_id`，缺失为 `unknown_session` | `opencode_{message.id}` |
| Kilo | `$XDG_DATA_HOME/kilo/kilo.db`（缺省 `~/.local/share`）的 `message` 表 | 同 OpenCode | `message.session_id`，缺失为 `unknown_session` | `kilo_{message.id}` |
| AntGravity | `~/.gemini/{antigravity,antigravity-cli}/brain/<会话>/.system_generated/logs/transcript.jsonl` | `MODEL/PLANNER_RESPONSE/DONE` 完整顶层用量；旧 App 无用量且无 status 的记录保留估算 | 根下合法会话目录名 | `antigravity_{session_id}_{step_index}` |
| MiniMaxCode v2 / MiniMax/Marvis 旧库 | 优先扫描 `~/.minimax/v2/sqlite/runtime-state.sqlite` 的 `local_runtime_token_usage`；同时兼容 `~/.minimax/sqlite.db` 的 `token_usage`，不存在时回退 `~/.mavis/sqlite.db`。两个旧路径视为同一别名，每次只扫描一个 | 每行 usage；v2 与旧库通过原生 SQLite 只读事务读取，实时合并 WAL | `session_id`，缺失为 `unknown_session` | 两代都沿用 `mavis_{session_id}_{id}`，迁移时保留相同 session/id 的行不会重复入库 |
| 腾讯 Marvis | Windows: `%APPDATA%/Tencent/Marvis/User/{user}/database/data.db`，macOS: `~/Library/Application Support/com.tencent.mac.marvis/MarvisData/User/{user}/database/data.db` 的 `llm_token_usage` 表 | 每行 `llm_token_usage`；直接枚举用户库并按整数 `id` 增量读取，不递归遍历完整数据树 | `conversation_id`，缺失为 `unknown_session` | `marvis_tencent_{user_id}_{id}` |
| WorkBuddy 项目日志 | `~/.workbuddy/projects/**/*.jsonl` | 多个候选 `usage` 字段任一可解析 | `sessionId`，缺失用文件名 stem | `workbuddy_project_{session_id}_{id或行号}` |
| WorkBuddy Agent 日志 | 各平台 WorkBuddy `logs/WorkBuddy*.log` | `Agent execution successful with usage: {...}` | 请求 ID | `workbuddy_{请求ID}` |
| Qclaw JSONL | `~/.qclaw/agents/**/*.jsonl` | `message.usage` 存在 | 文件名 stem | `qclaw_jsonl_{session_id}_{id或行号}` |
| Qclaw Hermes 响应库 | `~/.qclaw-hermes/response_store.db` 的 `responses` 表 | `data.response.usage` 存在 | `response_id` | `hermes_{response_id}` |
| Hermes | Windows `%LOCALAPPDATA%/hermes/state.db`，macOS `~/Library/Application Support/hermes/state.db`，Linux `$XDG_CONFIG_HOME/hermes/state.db`（缺省 `~/.config`） | `sessions` 表中 `input_tokens` 或 `output_tokens` 大于 0 | `sessions.id` | `hermes_{id}` |
| ReasoniX | 经典 `~/.reasonix/sessions/*.meta.json`；新版 `~/.reasonix/projects/*/sessions/*.jsonl.telemetry.json`（Windows 另探测 `%APPDATA%\reasonix`、`%LOCALAPPDATA%\reasonix`）。新版会话配对的 `<id>.jsonl.meta` 提供真实模型与 RFC 3339（UTC）时间；时间戳优先级为 meta `updated_at`（转本地）→ meta `created_at`（转本地）→ 会话 id 内嵌 UTC 时间（转本地）→ 文件 mtime → 扫描时刻 | 三类 Token 不全为 0 | 会话崩溃恢复分叉（`<root>[-<hex12>]…-recovery-<hex>`）折叠回根会话 id，整个家族只出账一次 | `reasonix_{root_session_id}` |
| Trae | 各平台 `TRAE*/logs/**/*ai-agent*_stdout.log` | 包含 `HistoryEvent` 且 `item_token_usage > 0` | `session_id`，缺失用 `conversation_id` | `trae_{history_id}` |
| DeepSeek GUI | 默认 `~/.deepseekgui/kun/threads/*/events.jsonl`，可由设置文件 `agents.kun.dataDir` 覆盖 | `kind == "usage"` 且增量后三类 Token 不全为 0；同一 `turnId` 的累计 usage 会转为增量 | `threadId`，缺失用线程目录名 | `deepseekgui_{session_id}_{seq或行号}` |
| DeepSeek 官方 DSH | `~/.dsh/sessions/**/session.jsonl.zstd`（旧版）与 `~/.dsh/sessions/**/session.v3.jsonl.zstd`（自 2026-09-11 起的新版命名，按 `session` + 可选 `vN` + `.jsonl.zstd` 识别并兼容后续 `session.vN`） | 只记录 `type == "assistant/message"` 且 `data.usage` 中输入/输出/缓存读取不全为 0 的逐请求行；`assistant/chunk` 是同一 usage 的流式副本，不扫描；同一会话目录内新旧两代并存时（DSH 改名会就地重写历史会话）只取世代最高的文件，避免同一 message id 重复计账；未变文件按 `dsh-session-zstd-v1` 检查点跳过 | 压缩流首条 `type == "session"` 的 `id`，缺失时用会话目录名 | `dsh_{sessionIdSha96}_{messageIdSha96}`；消息无 id 时以 `seq`或行号作哈希输入，不暴露本地路径 |
| Grok CLI | `~/.grok/logs/unified.jsonl`（全局单文件追加写）；模型名取自 `~/.grok/sessions/**/summary.json` 的 `current_model_id`（按 `sid` 映射） | 只记录 `msg == "shell.turn.inference_done"` 的逐请求行；文件中其余记录（auth、model catalog 等噪音）跳过；未变文件按 `grok-unified-jsonl-v1` 检查点跳过 | 记录顶层 `sid` | `grok_{sessionIdSha96}_{sid|ts|loop_indexSha96}`，不暴露本地路径 |
| Gemini CLI | 默认 `~/.gemini/tmp/<项目>/chats/**/*.{json,jsonl}`；设置 `GEMINI_CLI_HOME` 时改读 `$GEMINI_CLI_HOME/.gemini/tmp`，覆盖主会话与 `chats/<parentSessionId>/<sessionId>.jsonl` 子代理；与 AntGravity 的 `~/.gemini/antigravity/brain` 路径天然不相交 | 只记录 `type == "gemini"` 且 `tokens` 必填字段完整、计数器非负有限整数、时间戳可解析的 assistant 消息；`promptTokenCount` 扣除 `cachedContentTokenCount` 得净输入，`candidatesTokenCount + thoughtsTokenCount` 得输出；坏 JSONL 中间行可跳过、尾行与整文件读失败不推进 `gemini-cli-chats-v2` 检查点 | 会话头/顶层 `sessionId`，缺失用文件名 stem；旧版无消息 id 时使用消息数组位置 | `gemini_cli_{sessionIdSha96}_{messageIdSha96}`，不暴露本地路径 |
| Zcode | `~/.zcode/cli/db/db.sqlite` 的 `model_usage` 表（每请求粒度） | 每行 `model_usage`，且三类 Token 不全为 0（`status='error'` 行全 0 被跳过）；`turn_usage`/`tool_usage` 不扫描以免重复计数 | `session_id` | `zcode_{id}` |
| Kimi Code | `${KIMI_CODE_HOME:-~/.kimi-code}/sessions/wd_*/session_*/agents/*/wire.jsonl`（main 与每个 subagent 各一份 wire，全部扫描）；兼容旧路径 `~/.kimi/sessions` | `type == "usage.record"` 且 `usageScope` 为 `turn`、`session` 或缺失；两种 scope 都是逐请求增量，未知 scope、负数/全零用量与无效时间跳过；未变化文件按 `kimi-wire-jsonl-v2` checkpoint 跳过 | wire 路径中的会话目录名 | 已存在的 turn 行保持 v1 键兼容；session、旧格式及真实键碰撞使用 `kimi_v2_{sourceHash}_{line}_{recordHash}`，不暴露本地路径 |
| Kimi Desktop | Windows `%APPDATA%/kimi-desktop/daimon-share/daimon/runtime/kimi-code/home/sessions`、macOS `~/Library/Application Support/kimi-desktop/.../sessions`、Linux `$XDG_CONFIG_HOME/kimi-desktop/.../sessions`（缺省 `~/.config`）（desktop 内嵌 kimi-code runtime，wire 布局、usage 字段与跳过规则同 Kimi Code；会话目录也可能是 `conv-*`/`ctitle-*` 形态） | 同 Kimi Code；未变化文件按独立 `kimidesktop-wire-jsonl-v2` checkpoint 跳过 | wire 路径中的会话目录名（如 `conv-abc123`） | 与 Kimi Code 完全隔离的键空间：turn 行 `kimidesktop_{session}_{agent}_...`，其余 `kimidesktop_v2_{sourceHash}_{line}_{recordHash}`，绝不与 CLI `kimi_*` 别名冲突 |
| Pi | 默认根 `~/.pi/agent/sessions/--<编码后的 cwd>--/<时间戳>_<uuid>.jsonl`（`PI_CODING_AGENT_DIR` 改 agent 目录，`PI_CODING_AGENT_SESSION_DIR` 或 `--session-dir` 直接替换整个会话根）；另一条根是 Multica Desktop 托管 Pi runtime 的 `~/.multica/pi-sessions/*.jsonl`（每个 run 一个文件；同目录 0 字节的 `<同名>.jsonl.lock` 不扫描）。两条根都要扫，否则 Multica 上的 Pi 用量整体漏采；Cindy 桌面端另有 `<userData>/pi-agent-home/sessions` | v3 JSONL 会话树：`type == "message"` 且 `message.role` 为 `assistant`（模型调用）或 `toolResult`（工具内嵌的 LLM 调用），加上 `compaction` / `branch_summary` 条目上的可选 `usage`；只有四项计数全 0 才跳过，`stopReason` 为 `error`/`aborted` 的行照常计费，缺 `usage`、无效时间或负数计数跳过；树分叉与被放弃的分支同样是已发生的真实请求，按全文件求和而非只走当前 leaf；未变化文件按 `pi-session-jsonl-v1` checkpoint 跳过 | 会话首行 header 的 `id`；Multica 的文件名是本地时间戳，不是会话身份 | `pi_{entryIdSha96}_{timestampSha96}`；entry id 是会话树身份且被 `/fork` 原样复制，故键**不含**会话 id，复制回来的历史前缀与原文件碰撞而不会双计；无 id 的畸形条目回退 `pi_L{行号}_{timestampSha96}`，不暴露本地路径 |
| Qwen Code | `${QWEN_RUNTIME_DIR 或 QWEN_HOME，缺省 ~/.qwen}/projects/<编码后的 cwd>/chats/**/*.jsonl`（每会话一份 JSONL，三个根去重后都扫描）；只读 `chats` 目录下的 `.jsonl`，不打开设置、账号或 OAuth 文件 | `type == "assistant"` 且带 `usageMetadata` 的逐请求记录；计数器须为非负整数、时间戳可解析，全零跳过；坏 JSONL 中间行跳过、尾行坏或读失败不推进 `qwen-code-chats-jsonl-v1` 检查点 | 记录内 `sessionId`，缺失用文件名 stem | `qwen_{sessionIdSha96}_{uuidSha96}`；续聊或分叉把同一记录（同 `uuid`）带进另一个文件时只记一次，不暴露本地路径 |
| GitHub Copilot CLI | `${COPILOT_HOME:-~/.copilot}/session-state/<sessionId>/events.jsonl`；只解析 `session.start` 与 `session.shutdown` 两类事件，不打开配置、登录或插件文件 | 逐请求的 `assistant.usage` 事件不落盘，能读到的只有 `session.shutdown` 的 `data.modelMetrics.<模型>.usage`（每个模型的会话合计）。每个 shutdown 每个模型一行；续聊后同一文件里的下一个 shutdown 若四个计数都不小于上一个，就只记增量，有计数变小则视为新进程重新计数、按原值记；四个计数缺一或非法整条跳过；未变文件按 `copilot-cli-events-jsonl-v1` 检查点跳过 | `session.start` 的 `data.sessionId`，缺失用会话目录名 | `copilot_{sessionIdSha96}_{shutdown事件idSha96}_{模型Sha96}`，重扫幂等，不暴露本地路径 |
| Cline / Roo Code / Kilo Code | 编辑器用户目录 `<Code、Code - Insiders、VSCodium、Cursor、Windsurf、Kiro>/User/globalStorage/<扩展 id>/tasks/<任务>/ui_messages.json`（扩展 id 依次为 `saoudrizwan.claude-dev`、`rooveterinaryinc.roo-cline`、`kilocode.kilo-code`；Windows 在 `%APPDATA%`、macOS 在 `~/Library/Application Support`、Linux 在 `$XDG_CONFIG_HOME` 或 `~/.config`），另读 Cline CLI 的 `~/.cline/data/tasks`；Cline 另读同目录 `task_metadata.json` 取模型；对话历史、设置与密钥不打开 | `say == "api_req_started"` 且 `text` 里带 `tokensIn` 的逐请求消息；`partial` 中的流式消息、没拿到用量的失败请求跳过；整文件改写，读到半截 JSON 时不推进 `cline-family-ui-messages-v1` 检查点 | 任务目录名 | `{cline|roo|kilocode}_{任务目录名Sha96}_{消息ts}` |
| goose | `<数据目录>/sessions/sessions.db`：设置了绝对路径 `GOOSE_PATH_ROOT` 时数据目录为 `$GOOSE_PATH_ROOT/data`，否则 Linux `${XDG_DATA_HOME:-~/.local/share}/goose`、macOS `~/Library/Application Support/Block.goose`、Windows `%APPDATA%/Block/goose/data`；只读方式打开，只查 `usage_ledger` 表 | `usage_ledger` 每行一次模型调用（含上下文压缩调用）；负数计数或全零行跳过；没有这张表的旧版数据库不入账；`sessions` 表里的会话合计是这些行的汇总，不读 | `usage_ledger.session_id` | `goose_{sessionIdSha96}_{ledger行id}` |

### Token 字段映射

| 工具 | `input_tokens` | `output_tokens` | `cached_tokens` | `model` | `cost_usd` |
| --- | --- | --- | --- | --- | --- |
| Claude | `message.usage.input_tokens` | `message.usage.output_tokens` | `cache_read_input_tokens + cache_creation_input_tokens`（其中 `cache_creation_input_tokens` 计入 `cache_write_tokens`） | `message.model`，缺失为 `claude-unknown` | 不落库 |
| Codex | `max(逐请求input - cache read - cache write, 0)`；逐请求值优先取 `last_token_usage`，缺失时由 `total_token_usage` 高水位差分 | 同一逐请求值的 `output_tokens`；`reasoning_output_tokens` 只用于签名，不重复相加 | `cached_input_tokens`/`cache_read_input_tokens` + `cache_write_input_tokens`（兼容旧 `cache_write_tokens`） | 取最近一条 `turn_context.payload.model`（首个 `turn_context` 之前的行回填为本会话首个模型）；无 `turn_context` 时兜底 `codex-agent` | 不落库 |
| OpenCode/Kilo | `data.tokens.input` | `data.tokens.output + data.tokens.reasoning` | `data.tokens.cache.read + data.tokens.cache.write` | `data.modelID` 或 `data.model.modelID` | `data.cost` |
| AntGravity | 优先取 CLI `MODEL/PLANNER_RESPONSE/DONE` 的 `input_tokens`；旧版 App 无用量且无 status 行回退当前累计上下文字符数 / `3.5`（最小为 1） | 优先取 `output_tokens`；旧版 App 回退模型内容与工具调用字符数 / `3.5`（最小为 1） | 优先取 `cache_read_tokens`（`cache_write_known = false`）；旧版 App 固定 0 | 会话持久设置模型标签，缺失为 `antigravity-unknown`（旧版 v1 曾固定 `gemini-3.5-flash-agent`，由 v16 标记来源、v3 检查点重扫纠正模型） | 不落库 |
| MiniMaxCode v2 / MiniMax/Marvis 旧库 | `input_tokens` | `output_tokens + reasoning_tokens`，旧库无 `reasoning_tokens` 时按 0 处理 | `cache_read_tokens + cache_write_tokens` | `model`；为空时回退到 `local_runtime_message_rows` 里同一请求的 `context_usage_telemetry.model`，仍取不到才记 `minimax-unknown`（不拼造模型名） | `cost_usd` 大于 0 时落库；为 0 视为「未上报」存 NULL，交价格表派生 |
| 腾讯 Marvis | `input_tokens` | `output_tokens` | `cached_tokens`，缺失为 0 | `model_id`，缺失为 `marvis-unknown` | 不落库 |
| WorkBuddy 项目日志 | 候选字段：`inputTokens`、`input_tokens`、`prompt_tokens`、`cachedMissTokens`、`prompt_cache_miss_tokens`；若三类 Token 全 0，则用 `totalTokens` 或 `total_tokens` 兜底到输入 | `outputTokens`、`output_tokens`、`completion_tokens` | 缓存读取首个非空（`cacheTokens`/`cached_tokens`/`cache_read_input_tokens`/`prompt_cache_hit_tokens`，再退到 `prompt_tokens_details.cached_tokens`、`inputTokensDetails.cached_tokens`）；缓存写取首个非空（`cache_creation_input_tokens`/`prompt_cache_write_tokens`/`cachedWriteTokens`）计入 `cache_write_tokens`；当 input 命中 `prompt_tokens`（含缓存）时扣减缓存读，避免重复计入 | `providerData.model` 或 `data.model`；对象时取 `modelID` 或 `id` | `cost_usd` 或 `cost` |
| WorkBuddy Agent 日志 | `usage.inputTokens` | `usage.outputTokens` | `usage.cacheTokens` | `workbuddy-{agent_name}`，缺失为 `workbuddy-workbuddy-agent` | 不落库 |
| Qclaw JSONL | `message.usage.input`；若三类 Token 全 0，则用 `totalTokens` 兜底到输入 | `message.usage.output` | `cacheRead + cacheWrite` | `message.model`，缺失为 `qclaw-model` | `message.usage.cost.total` |
| Qclaw Hermes 响应库 | `response.usage.input_tokens` | `response.usage.output_tokens` | `cache_read_input_tokens + cache_creation_input_tokens` | `response.model`，缺失为 `hermes-model` | 不落库 |
| Hermes | `sessions.input_tokens` | `sessions.output_tokens` | `cache_read_tokens + cache_write_tokens` | `sessions.model` | `actual_cost_usd`，缺失用 `estimated_cost_usd` |
| ReasoniX | `max(cacheMissTokens, promptTokens - cacheHitTokens)`：中转 provider 不一定回传缓存明细，只取 `cacheMissTokens` 会漏掉真实付费的输入 | `completionTokens`，旧格式 `totalCompletionTokens`（已含 `reasoningTokens`，不另计） | `cacheHitTokens` | 会话 `<id>.jsonl.meta` 的 `model`，缺失回退候选 `config.toml` 的 `default_model`、旧版 `config.json` 的 `model`，再缺失为 `reasonix-agent` | `sessionCostUsd`，旧格式 `totalCostUsd`；为 0 时视为「该 provider 未配置价格」并留空交给价格表 |
| Trae | 当 `source != "llm_default"` 时为 `item_token_usage`，否则为 0 | 当 `source == "llm_default"` 时为 `item_token_usage`，否则为 0 | 固定 0 | 日志内转义 JSON 的 `model` 或 `model_name`，缺失为 `MiniMax-M2.7` | 不落库 |
| DeepSeek GUI | `cacheMissTokens` 增量；缺失时由 `promptTokens - cacheHitTokens` 推导 | `completionTokens` 或 `completion_tokens` 的增量 | `cacheHitTokens`、`cachedTokens` 或 `cached_tokens` 的增量 | `data.model`，缺失为 `deepseek-v4-pro` | 不落库 |
| DeepSeek 官方 DSH | `data.usage.inputTokens`（已排除缓存读取） | `data.usage.outputTokens`；`reasoningTokens` 是其中的推理细分，不另行相加 | `data.usage.cacheReadTokens`；无缓存写字段，`cache_write_tokens = 0` | `data.message.source.model`，缺失回退最近 `request/header.data.header.config.model`，再缺失为 `dsh-unknown` | 不落库 |
| Grok CLI | `max(prompt_tokens - cached_prompt_tokens, 0)`（`prompt_tokens` 含缓存读，落库前归一为净输入） | `completion_tokens`；`reasoning_tokens` 是其中的推理细分，不另行相加 | `cached_prompt_tokens`；无缓存写字段，`cache_write_tokens = 0` | 会话 `summary.json` 的 `current_model_id`（按 `sid` 映射，经 `clean_model_name`），缺失为 `grok-unknown` | 不落库 |
| Gemini CLI | `tokens.input - tokens.cached`（官方 `promptTokenCount` 含缓存；必须满足 `total = input + output + thoughts`） | `tokens.output + tokens.thoughts`（官方 `candidatesTokenCount` 与 `thoughtsTokenCount` 均计入输出） | `tokens.cached`；无缓存写字段，`cache_write_tokens = 0` | 消息内 `model`（经 `clean_model_name`，是实际调用的模型而非 settings.json 配置），缺失为 `gemini-unknown` | 不落库 |
| Zcode | `max(input_tokens - 缓存读写, 0)`（来源 `input_tokens` 含缓存读，`computed_total_tokens == input + output` 已逐行验证；扫描器归一为净输入，schema v10 起生效） | `output_tokens + reasoning_tokens` | `cache_read_input_tokens + cache_creation_input_tokens`（其中 `cache_creation_input_tokens` 计入 `cache_write_tokens`） | `model_id` | 不落库 |
| Kimi Code | `usage.inputOther`（非缓存新鲜输入） | `usage.output` | `usage.inputCacheRead + usage.inputCacheCreation`（其中 `inputCacheCreation` 计入 `cache_write_tokens`） | `model`，缺失为 `kimi-unknown` | 不落库 |
| Kimi Desktop | 同 Kimi Code（`usage.inputOther`） | 同 Kimi Code（`usage.output`） | 同 Kimi Code（`inputCacheRead + inputCacheCreation`） | 同 Kimi Code（`model`，缺失为 `kimi-unknown`），tool 记 `kimidesktop` | 不落库 |
| Pi | `message.usage.input`（Pi 官方实现已扣除缓存读写的净输入） | `message.usage.output`；`usage.reasoning` 是其中的推理细分，不另行相加 | `usage.cacheRead + usage.cacheWrite`（其中 `usage.cacheWrite` 计入 `cache_write_tokens`） | 条目自身的 `message.model`（经 `clean_model_name`）；`toolResult`/`compaction`/`branch_summary` 回退会话当前模型（`model_change.modelId` 或最近一条 assistant 的 `model`），再缺失为 `pi-unknown` | 不落库（`usage.cost` 是 Pi 按自己内置价格算的值，实测恒为 0；统一由本地价格表估算，改价时可重算） |
| Qwen Code | `promptTokenCount - cachedContentTokenCount`（`promptTokenCount` 含缓存读；缓存大于 prompt 的记录整条跳过） | `candidatesTokenCount`；仅当 `totalTokenCount ≥ prompt + candidates + thoughts`（Gemini 原生响应，思考 Token 单列）时再加 `thoughtsTokenCount`，OpenAI/Anthropic 兼容响应的思考 Token 已含在 candidates 里，不重复相加 | `cachedContentTokenCount`；无缓存写字段，`cache_write_tokens = 0` | 记录内 `model`（经 `clean_model_name`），缺失为 `qwen-unknown` | 不落库 |
| GitHub Copilot CLI | `inputTokens - cacheReadTokens - cacheWriteTokens`（OpenAI 风格，`inputTokens` 含缓存）；缓存合计大于 `inputTokens` 时视为已是净输入，原样记 | `outputTokens`；`reasoningTokens` 是其中的细分，不另行相加 | `cacheReadTokens + cacheWriteTokens`（其中 `cacheWriteTokens` 计入 `cache_write_tokens`） | `modelMetrics` 的键（经 `clean_model_name`） | 不落库（`requests.cost` 是高级请求倍数，不是美元） |
| Cline / Roo Code / Kilo Code | `tokensIn`；请求标了 `apiProtocol == "openai"`，或未标注但 `cacheWrites == 0` 且 `tokensIn ≥ cacheReads` 时视为含缓存，记 `tokensIn - cacheReads` | `tokensOut` | `cacheReads + cacheWrites`（其中 `cacheWrites` 计入 `cache_write_tokens`） | Cline 按 `task_metadata.json` 的 `model_usage` 取请求时刻生效的 `model_id`（经 `clean_model_name`）；Roo / Kilo 不记模型，为 `roo-unknown` / `kilocode-unknown` | `cost` 大于 0 时落库，为 0 或缺失时按估算 |
| goose | `input_tokens - cache_read_tokens - cache_write_tokens`（goose 记的是含缓存的完整 prompt）；缓存合计大于输入时原样记 | `output_tokens` | `cache_read_tokens + cache_write_tokens`（其中 `cache_write_tokens` 计入 `cache_write_tokens`） | `model`（经 `clean_model_name`），缺失为 `goose-unknown` | `cost_source == "provider_reported"` 且大于 0 时落库；goose 自己估的价不采用，按估算重算 |

### 容易漂移的约束

- OpenCode 和 Kilo 会先直接扫描各自 SQLite；是否跳过 MiniMaxCode v2 或旧库中 `framework_type` 为 `opencode`/`kilo` 的行，由对应的 `opencode.db`/`kilo.db` **文件是否存在**决定（静态规则）。这避免了旧逻辑「按本次扫描是否取到记录判断」在 DB 被锁或临时为空时翻转，导致同一请求以 `mavis_*` 和 `opencode_*` 两套 `unique_key` 双记。
- MiniMaxCode v2 与旧库的工具归属只看产生这条记录的 App：`framework_type` 命中 `opencode`/`kilo` 时写入对应工具，否则一律写入 `minimax`。**工具身份不由模型串决定**——按模型名前缀划分会让 MiniMax Code 跑别家模型时被记到无关的腾讯 Marvis 名下，也会让来源少写一列就整个换归属。`marvis` 只剩腾讯 Marvis 一个来源。v2 优先于旧库扫描，旧版 `.minimax` / `.mavis` 路径只择一，避免迁移安装把同一旧库读两遍。
- **模型缺失时从逐请求记录恢复，仍不恢复才记未知**：MiniMax Code 自 2026-08-24 起不再写 `local_runtime_token_usage.model`，但每条助手消息仍带 `context_usage_telemetry.model`，且 `data_json.usage` 的 `input_tokens`/`output_tokens`/`cache_read`/`total_tokens` 与同一请求的用量行**逐字段相等**，可作为精确配对键（缺失成员按 0 归一化）。本机实测 1,900 余条空模型行恢复率 99.8%，配对键无冲突；拿 2026-08-21 前有真值的行交叉校验，去掉供应商前缀后 104/104 完全一致。
  - **不能用会话级的 `local_runtime_sessions.extra_data_json.effectiveModel`**：那是会话「当前」模型而非历史值，真实存在同一会话中途从 `deepseek-v4-flash` 切到 `gpt-5.6-sol` 的情况（实测 2 例），按会话取会把切换前的请求全部贴错。
  - 旧实现回退到 `mavis-{agent_name}` 的时代已由 schema v11 就地改写；本次把 `PARSER_VERSION` 提到 2 触发全量重扫，配合 `runner.rs` 的 minimax 改写分支（`INSERT OR IGNORE` 不会更新已存在的行）把历史行纠正到真实模型，并重置 `sync_status` 让云端 upsert 覆盖旧标签。`unique_key` 不含 tool/model，不影响去重。
- MiniMaxCode v2 与旧库的 `reasoning_tokens` 是输出侧补充字段，需要计入 `output_tokens`。
- **MiniMax Code 的成本一律由价格表派生**：实测旧库 `token_usage.cost_usd` 与 v2 `raw.cost` 在全部真实行上恒为 0，从没有过一次真实账单。把 0 当成「免费」落库会让记录永远停在 $0（非 NULL 会压过价格表），因此扫描器把 0 视为「未上报」存 NULL；真实非 0 的供应商数值原样保留。`minimax` 相应回到 `mark_scanner_costs_for_repricing` 的名单里，改价后会重新派生——它此前被排除的理由「v2 runtime 自带 cost」已不成立。
- 腾讯 Marvis 的 `llm_token_usage` 表存在 `thinking_tokens`，但当前样本中 `total_tokens = input_tokens + output_tokens`，说明思考量已包含在输出总量关系里，不再额外相加。
- WorkBuddy 优先使用项目 JSONL 日志；只要项目日志产生了记录，就不会再扫描 Agent 日志。
- Qclaw 的 Hermes 响应库记录会以 `tool = "hermes"` 写入，并与独立 Hermes 共用 `hermes_{id}` 风格的去重命名空间。
- AntGravity 区分 CLI 真实上报（`MODEL/PLANNER_RESPONSE/DONE` 的 `input_tokens`/`output_tokens`/`cache_read_tokens`，标记 `reported`）与旧版 App 字符数 / `3.5` 估算（标记 `estimated`）；细则见下方「Antigravity CLI 采集范围」。
- Trae 用 `source == "llm_default"` 判断输出 Token，其余来源归为输入 Token。
- DeepSeek GUI 的 `usage` 是同一 `turnId` 的累计快照；scanner 会按 `(threadId, turnId)` 做相邻快照差值。缺失 `turnId` 时按单条记录处理，不跨事件相减。
- DeepSeek GUI 中 `promptTokens` 通常等于 `cacheHitTokens + cacheMissTokens`；入库的 `input_tokens` 表示非缓存输入，避免把缓存命中同时计入 `input_tokens` 和 `cached_tokens`。
- DSH 每个完成请求先写 `assistant/chunk.data.chunk.usage`，后写数值相同的 `assistant/message.data.usage`；扫描器只接受后者。真实日志中后续请求同时有较小 `inputTokens` 和较大 `cacheReadTokens`，因此两者分列，缓存不重复并入有效 Token。`reasoningTokens <= outputTokens` 且作为输出细分，不与 `outputTokens` 相加。
- Grok CLI 的 `prompt_tokens` 含缓存读（OpenAI 风格），scanner 在落库前扣除 `cached_prompt_tokens`，缓存不重复并入有效 Token；`reasoning_tokens` 是 `completion_tokens` 的输出细分，不另行相加。模型名不在 unified 日志记录内，靠 `sid` 关联会话 `summary.json` 的 `current_model_id`，会话缺失时兜底 `grok-unknown`（已列入占位符清单，不进入价格发现目录）；价格兜底键为 `grok-4.3`。同一 turn 的多次模型调用各产生一条 `inference_done`（`loop_index` 不同），均独立出账。
- Gemini CLI 会话有新旧两种格式（`chats/**/*.{json,jsonl}`；主会话文件名带 `session-`，子代理位于 `chats/<parentSessionId>/`），可由 `GEMINI_CLI_HOME` 指定 `.gemini` 所在根。官方记录的 `input` 是含缓存的 prompt，scanner 按 `input - cached` 落库为净输入；`output + thoughts` 作为输出，`total` 必须满足官方等式，否则整条跳过。消息内 `model` 记录的是实际调用的模型（settings.json 配置不识别的模型名会被 CLI 静默降级），缺失兜底 `gemini-unknown`（占位符清单已登记）；负数、非整数、超出单请求上限的计数器与无效时间戳 fail closed，整文件解析/读取失败与 JSONL 尾行坏数据不会提前推进 checkpoint；旧版无消息 id 时以消息数组位置形成稳定去重身份。价格兜底键为 `gemini-3.5-flash`。与 AntGravity 扫描器共用 `.gemini` 根但路径不相交（`tmp/*/chats` vs `antigravity/brain`），checkpoint 种类独立。
- Zcode 只扫描 `model_usage`（最细的每请求粒度）；`turn_usage` 是它的精确聚合、`tool_usage` 不含 Token，都不扫描以免重复计数。`model_usage` 行是每请求不可变记录，按 `zcode_{id}` 用 `INSERT OR IGNORE` 去重，不作累计增量。
- Codex 来源中的 `input_tokens` 含缓存读写，但 scanner 会在落库前扣除 `cached_tokens`；因此看板的 `input + output` 是有效 Token，切到“含缓存”口径后再加缓存恰好得到 provider 的 `input + output`，不会重复缓存。
- Codex 根身份只取文件的首个 `session_meta`；fork/subagent 会在同一文件后续重放父或祖先的 `session_meta`，不得据此改写 root session。显式父 ID 兼容 `forked_from_id`、顶层 `parent_thread_id` 与 `source.subagent.thread_spawn.parent_thread_id`，多字段冲突、自指、父文件缺失、父文件尚未写到分叉时刻或无有效时间戳时一律推迟该文件且不推进检查点。有父关系但匹配前缀为 0 是合法独立用量，不能整段丢弃。
- **Multica Desktop（多 runtime 编排器）**：Multica 为每个任务开一个隔离 agent HOME，Codex 被显式设置 `CODEX_HOME=<task>/codex-home`，因此它的 rollout **不会**出现在 `~/.codex/sessions`，只扫静态根会整体漏采。扫描器额外发现 `~/multica_workspaces_*/` 下深度 ≤4 的 `codex-home` 目录，并同时登记其 `sessions` 与 `archived_sessions`。目录名形态同时兼容现行的 `task-<hex>` 与旧版 8 位 hash；只有前缀为 `multica_workspaces_` 的家目录才会被采纳，其他产品自带的 `codex-home` 不参与。Multica daemon 会按自己的 TTL 回收已完成任务目录（`completed_task_ttl` 默认 14 天），因此**任务目录在发现与读取之间消失是预期行为，不计入 `failed_files`、不推迟重建**；但也意味着**超过 TTL 的历史用量无法追回**。
- **Cindy 桌面端**：Cindy 用自己的 `CODEX_HOME` 运行 Codex，rollout 不在 `~/.codex/sessions`。`<userData>` 是系统应用数据目录下的 `Cindy`（国内版）、`CindyGlobal`（国际版）或旧名 `xdt-maker`；应用数据目录在 Windows 是 `%APPDATA%`，macOS 是 `~/Library/Application Support`，Linux 是 `$XDG_CONFIG_HOME`（缺省 `~/.config`）。扫描器登记每个 `<userData>` 下 `codex-home` 与 `codex-accounts/<owner>/<provider>` 的 `sessions`、`archived_sessions`，以及 Pi 的 `pi-agent-home/sessions`。Cindy 会把从别处导入的线程复制进自己的目录，同一线程可能同时出现在 `~/.codex` 与 Cindy 目录：Codex 按线程 UUID 归并，只保留最长的一份并按事件取增量（两份各自续写、互不为前缀时该线程暂缓入账，下次扫描重试），fork 出来的线程跳过与父线程重合的回放前缀，因此多份副本或多个包含同段历史的线程不会把累计值重复相加。Cindy 的 Claude Code 会话写在默认的 `~/.claude`，已被既有扫描根覆盖。
- **额外 Codex 目录**：其他把 Codex 装在别处的应用，可在设置「扫描与启动」逐行填 Codex 主目录（含 `sessions`）或 `sessions` 目录本身，支持 `~` 与 `%APPDATA%` 这类占位；它们与上面的根一起按同样规则去重。
- **Multica 的 Claude 无需额外处理**：Multica 启动 Claude 时不设置 `CLAUDE_CONFIG_DIR`，会话直接写入全局 `~/.claude/projects/<编码后的 cwd>/`，已被既有 Claude 扫描根覆盖，不再单列来源。
- **Antigravity CLI 采集范围**：指定本地样本的 `MODEL/PLANNER_RESPONSE/DONE` 行具有顶层 `input_tokens`、`output_tokens`、`cache_read_tokens`。仅采集三项齐全、非负安全整数且 step/time 合法的该格式；输入与输出按原值记账，不减缓存读取，也不将 thinking 文本另估算后加到输出。此映射由指定样本和官方示例支持，不宣称覆盖所有发行版、事件类型、失败/取消或全部 `agy` 计费。新格式非法/部分用量不会降级字符估算；旧 App 无用量且无 status 的记录继续估算，来源以本机 `reported/estimated` 持久区分。
- **缓存与模型边界**：写入字段缺失仍是 unknown，包括读取为 0 的行；内部数值 0 是兼容占位，`cache_write_known=false` 禁止将其当成已知零。本机 `cached_tokens` 和既有 wire 的 `cachedTokens/cached` 是已观测的兼容记录量，缺写入时不承诺完整缓存总量。统计隐藏不可证明的读写拆分和缓存净节省；小时上传使用既有 `cache_write_tokens=null` 表达未知，不新增跨端字段。模型来自会话内持久设置事件的“选定模型标签”，不能证明实际服务端路由；无设置使用 `antigravity-unknown`，不进入价格发现。
- **去重、纠正与检查点**：只读双根的 compact `transcript.jsonl`，不累加 full、chunks 或其他附件。同会话任一候选的身份/大小/mtime 或成员变化都会重读整组，真实用量优先于估算，同键相等折叠，跨文件真实快照冲突时保留旧行并重试。reported 可整行纠正旧估算或旧实际值（包括下降），estimated 只允许纠正 estimated，跨重启或真实来源消失也不覆盖 reported。检查点已升级至 v3，强制重读旧 App 来源以纠正旧模型标签；原始文件已丢失的历史保留。坏尾行、读取失败或扫描中变化不推进组检查点。行、provenance 与检查点同事务落盘，实际纠正重置同步状态，并复用修订护栏及模型/小时旧桶修复机制；不清理生产历史或主动操作调用进程。
- Zcode 的 `input_tokens` 含缓存读（`computed_total_tokens == input + output` 已验证），扫描器落库前归一为净输入（schema v10 迁移删除毛值旧行并重扫重建；有效 Token 实测从虚高约 58 倍回落真实值）；`started_at` 是 13 位毫秒时间戳，由 `normalize_timestamp` 的 `>1e11` 规则归一。
- Hermes 与 ReasoniX 的会话行是原地累计快照，标记为 `cumulative`：落库时按 `(base_key + 已入库总和)` 求增量，写入带 `#t{in}_{out}_{cached}` 后缀的增量行，增量行时间戳取「扫描时刻」而非会话开始时间；来源总量回退（DB 重置、会话 ID 复用）时不写增量行，但重置累计基线。Hermes 的 `sessions` 行只要输入、输出、缓存三者任一大于 0 即纳入（不再因输入输出为 0 而漏掉纯缓存增长）。
- ReasoniX 崩溃恢复会 fork 出新会话文件（`<root>[-<hex12>]…-recovery-<hex>`），其 telemetry **继承父会话的累计计数器**，形成一条链。扫描器把整个家族折叠到根会话 id，只取各字段的最高水位（链的最深一环），否则同一批 Token 会被计 2~3 次；schema v8 会把历史上按 fork 键保存的累计基线一次性折叠回根键，`token_logs` 中已产生的历史行保持不变（多数来源文件已被 ReasoniX 清理，重扫无法重建）。
- ReasoniX 单条会话记录只带一个模型名（会话 meta 的当前模型）。会话中途换模型或换 provider 时，全部 Token 归到最后一个模型；`bcnw/x` 这类中转前缀会被 `clean_model_name` 去掉，因此中转流量按同名官方模型价格估算。要精确到每次请求的模型与消费时刻，需要改读 ReasoniX 的逐请求账本 `<base>/stats/YYYY-MM-DD.jsonl`，当前未接入。
- Kimi Code 的每条 `usage.record` 都是一笔逐请求增量；`usageScope` 只表示请求来自 turn 流程还是 session 级流程，不是累计标记，因此 `turn`、`session` 和旧版缺失 scope 的行都应计入。v2 检查点会在升级后执行一次重扫：旧 turn 行沿用原键并由 `INSERT OR IGNORE` 跳过，只补回 v1 漏掉的行；同一文件里同毫秒、同用量的真实请求以强化键区分。`time` 接受有效的秒或毫秒时间戳，无效值不再回退为“当前时间”。wire.jsonl 含完整提示词与工具上下文，扫描时先粗筛且只解析 usage 行，正文不写入日志或数据库。默认数据根可由 Kimi 官方支持的 `KIMI_CODE_HOME` 覆盖。
- Pi 的 `usage.input` 已扣除缓存读写（官方实现为 `prompt_tokens - cacheRead - cacheWrite`），`output` 含 `reasoning` 细分，`totalTokens` 恰好等于 `input + output + cacheRead + cacheWrite`，仅用于自校验；缓存读写分列，不并入有效 Token。会话文件是 append-only 的**树**：除当前 leaf 之外被放弃的分支、以及 `compaction`/`branch_summary` 自身的摘要调用都真实扣费，按全文件求和而不是只走 leaf 路径。正在运行的会话可能在扫描时留下半行 JSON：该行本次跳过，文件一旦变化就从字节零重扫，因此半行补全后既不漏也不重（追加/截断/替换/mtime 变化都会触发重扫）。去重键刻意不含会话 id，因为 `/fork`、`/clone` 会新建一个新会话 id 并把保留路径原样复制进新文件，含会话 id 就会把已计费的这段前缀双记；entry id + 原始毫秒时间戳在复制前后一致，正好抵消。Pi 自身默认根是 `~/.pi/agent/sessions/<编码后的 cwd>/`，可由 `PI_CODING_AGENT_DIR` 与 `PI_CODING_AGENT_SESSION_DIR`（或 `--session-dir`）覆盖；Multica Desktop 给 Pi 传的会话目录是 `~/.multica/pi-sessions`，与 Codex 的 `codex-home` 同类，不扫就会整体漏采。`usage.cost` 不落库，成本统一按本地价格表估算。
- Qwen Code 把各家响应统一成 Gemini 形状的 `usageMetadata`：OpenAI 兼容响应的 `candidatesTokenCount` 就是完整 completion，`thoughtsTokenCount` 只是其中的推理细分（provider 不报时还是按文本估算的），所以只有总数证明思考 Token 单列时才相加。Anthropic 兼容响应的缓存写入被并进 `promptTokenCount` 且不单独落盘，这部分会算进净输入，`cache_write_tokens` 记 0。转录里的 `ui_telemetry`、`tool_result` 等记录即使带用量字段也不出账，只认 assistant 记录。
- GitHub Copilot CLI 的用量只在会话正常结束（`session.shutdown`）时落盘：会话还开着、或进程被强杀没写 shutdown 时，这段用量暂时扫不到，等下次 shutdown 才入账，时间记在 shutdown 时刻。账本只从这个事件日志读数，不调用任何 GitHub 接口。
- Cline 系扩展的 `tokensIn` 口径随 provider 协议变化：Anthropic 协议不含缓存，OpenAI 协议含缓存读。Roo / Kilo 逐请求标了 `apiProtocol`，Cline 没有，只能按缓存计数推断，少数 OpenAI 协议且带缓存写的请求可能多记净输入。扩展在请求结束后才把最终用量写回同一条消息，扫描到未完成的消息会跳过、下次再读；Kilo Code 扩展记为 `kilocode`，和 Kilo CLI（`kilo`）分开。

### 项目维度（可选，默认关闭）

用户开启“按项目统计”后，独立的项目索引按会话读取工作目录，只保存项目名或固定分组，数据只在本机。它不改变上文任何 Token 字段、落库或去重规则。现行源码已接入设置「数据与帮助」→「按项目统计」：阅读读取范围说明，打开「按项目统计本机用量」开关，并在确认框点击「开启并建立索引」后才授权采集。行为分析中的「了解并开启」会跳转到该设置卡片，不会直接开启。入口与后端命令已接线，真实平台上的开启、索引与隐私显示体验仍待验收。git 探测按用户决定关闭，项目名取工作目录末级名称，worktree 目录与来源记录的仓库根取仓库文件夹名；能识别的主目录写法及其上级、与账户名同名的文件夹只记“主目录”（主目录经符号链接、`HOME` 与 `USERPROFILE` 不一致等写法尚未识别，见 DESIGN §4.9）。为找到工作目录，会从日志开头逐行跳过对话内容（有行数与字节上限），跳过的内容不提取、不保留。各来源的读取位置如下：

| 来源 | 工作目录字段 |
|---|---|
| Claude Code / Cowork | JSONL 行顶层 `cwd`（取首个，最多 64 行或 256 KiB）；Cowork 目录归“托管会话” |
| Codex | 首行 `session_meta.payload.cwd`（fork 重放的父级 `session_meta` 不读） |
| OpenCode / Kilo | 首条助手消息 `data.path.cwd`（`path.root` 作仓库根，只在 SQLite 内提取），缺失时取 `session.directory` |
| Zcode | `session.directory`（旧库 `session.path`） |
| MiniMax Code | v2 `local_runtime_sessions.project_workspace_dir`，缺失时取 `workspace_dir`，默认工作区归“托管会话”；旧库 `sessions.workspace_dir` |
| WorkBuddy 项目日志 | JSONL 行顶层 `cwd` |
| Qclaw JSONL / Pi | 会话头 `cwd` |
| Hermes | `sessions.cwd`，`sessions.git_repo_root` 作仓库根，缺 `cwd` 时取仓库根 |
| ReasoniX | meta 的 `workspace_root` / `workspace`，缺失时按同目录、编码核对一致的会话推断 |
| DeepSeek GUI | `threads/<id>/metadata.jsonl` 的 `thread.workspace`（最多 16 行或 1 MiB） |
| DSH | 最新一代会话文件首行 `type = session` 事件的 `cwd` |
| Grok CLI | `summary.json` 的 `info.cwd`，`git_root_dir` 作仓库根，缺 `cwd` 时取仓库根 |
| Gemini CLI | 会话所在 `tmp/<项目短名>/.project_root`，只取首个非空行，最多 4 KiB；另读会话文件开头的 `sessionId` 以定位会话 |
| Kimi Code / Kimi Desktop | 依次取 `state.json.workDir`、`session_index.jsonl` 的 `workDir`、`state.json.cwd`、`workspaces.json` 的工作区 `root`（只接受字符串） |
| Antigravity、腾讯 Marvis、Trae、WorkBuddy Agent 日志、Qclaw Hermes 响应库、Qwen Code（记录里有 `cwd`，项目索引暂未接入） | 无，显示为“未归属” |

---

## 项目结构

```text
TokenLedger/
├── src/                         # React 前端
│   ├── App.tsx                  # 主界面、数据加载、动作入口
│   ├── main.tsx                 # React 入口
│   ├── index.css                # Tailwind 入口样式
│   ├── types.ts                 # 前后端共享数据形状
│   ├── components/              # 看板与设置页组件
│   ├── features/gateway/        # 本地网关（模型供应商接入）界面
│   └── utils/                   # 前端工具函数
├── src-tauri/                   # Rust 后端与 Tauri 配置
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   ├── capabilities/
│   ├── icons/
│   └── src/
│       ├── lib.rs               # Tauri 运行时、托盘、后台调度器
│       ├── commands/            # Tauri IPC 命令、云同步、统计聚合及其测试
│       │   └── mod.rs
│       ├── quota/               # 额度 Provider、v1 类型、各来源适配器与供应商余额（balance/）
│       ├── quota_sync.rs        # 额度快照跨设备同步
│       ├── scanner/             # 多工具日志扫描器（runner.rs 调度 + 按工具拆分的解析器）
│       ├── gateway/             # 本地 OpenAI 兼容模型网关与用量账本（ADR-017）
│       ├── project_index/       # 本机项目维度索引（ADR-016，默认关闭）
│       ├── session_analysis/    # 本机按需会话元数据分析（不进 Stats v2 与云同步）
│       ├── cost_profile/        # 订阅设置（费用口径）读写
│       ├── stats_query.rs       # 统计查询下推
│       ├── models_dev.rs        # models.dev 价格目录
│       ├── widget_window.rs     # 桌面挂件窗口
│       ├── db.rs                # SQLite 表结构和迁移
│       ├── cache.rs             # 本地统计缓存
│       ├── settings.rs          # 应用设置读写
│       ├── app_paths.rs         # 跨平台应用数据目录
│       └── wallpaper.rs         # 壁纸渲染与平台集成
├── apps/android/                # 原生 Android 只读云端看板
├── extensions/vscode/           # VS Code 状态栏插件（读 tokenledger-cli 的 JSON，零依赖）
├── scripts/                     # 构建与版本一致性检查脚本
├── supabase/                    # Supabase schema 与部署说明
├── package.json
├── vite.config.ts
└── start_tokenledger*.bat       # Windows 启动脚本
```

模块边界：

- `src/` 只负责用户界面、交互和图表展示。
- `src-tauri/src/` 负责本地数据库、扫描器、云同步、壁纸渲染和 Tauri 命令。
- `apps/android/` 负责原生 Android APK，只读取云端聚合看板数据。
- `scripts/` 负责构建前的版本一致性校验。
- `supabase/` 只维护云端表结构、聚合视图和 RPC 部署说明。
- `legacy/` 下的旧 Node.js + Python 源码已删除，目录仅剩未跟踪的本地调试数据库，不代表当前功能。

---

## 运行测试

开发中只跑与改动相关的检查：

```bash
npm run typecheck                              # 前端类型检查
npm run check:docs                            # 文档与契约门禁
cargo test --manifest-path src-tauri/Cargo.toml   # Rust 单测
```

合入前，维护者会在本机对集成结果跑一次完整门禁：

```bash
npm run check                                 # 全量门禁（含类型检查、lint、前端与 Rust 测试、构建）
```

Android 与 Supabase 只在改动涉及时追加：

```bash
npm run android:verify                        # Android 编译与 lint
node scripts/run-android-gradle.mjs :app:validateDebugScreenshotTest   # 截图回归
```

桌面前端改了界面或交互时追加浏览器级回归（Playwright，Chromium + WebKit，420–1440 宽度，含少量截图基线；说明见 [e2e/README.md](e2e/README.md)）：

```bash
npx playwright install chromium webkit        # 首次运行前装浏览器
npm run test:e2e                              # 浏览器回归
npm run test:e2e:update                       # 有意改变画面时重新生成截图基线
```

`npm run check` 结束时会验证被跟踪文件未被门禁修改。CI 工作流保留在 `.github/workflows/` 中，但它不作为验收依据——验收只认本机实际运行的门禁。

贡献流程、提交规范与代码约定见 [CONTRIBUTING.md](CONTRIBUTING.md)。

---

## 平台支持

| 平台 | 主界面 | 系统托盘 | 桌面壁纸 | 锁屏壁纸 |
| --- | --- | --- | --- | --- |
| Windows | 支持 | 支持 | 支持 | 支持 |
| macOS | 支持 | 支持 | 部分支持 | 不支持 |
| Linux（仅源码构建，不在公开支持范围内） | 可构建 | 可构建 | 部分实现 | 不支持 |

Windows 专属能力通过条件编译隔离；macOS/Linux 构建不会拉取 WinRT 锁屏相关实现。

---

## 快速开始

### 1. 环境要求

- Rust 构建工具链固定为 1.96.0，`src-tauri/Cargo.toml` 的 `rust-version = 1.92` 仍表示最低兼容版本；固定版本用于让本地、CI 和 release 的 rustfmt/Clippy 结果一致。
- Node.js 18 或更高版本，推荐 20 LTS
- npm 或 pnpm

### 2. 安装依赖

```bash
npm install
```

### 3. 开发模式

```bash
npm run dev
```

该命令会启动 Vite 开发服务器和 Tauri 主进程。

### 4. 类型检查

```bash
npm run typecheck
```

完整且可重复的开发门禁：

```bash
npm run check
```

该门禁覆盖版本、跟踪路径长度、类型、ESLint（react-hooks 依赖规则）、前端契约、前端生产构建、图表 raw/gzip 预算、Rust 测试与空白错误，并验证整个过程没有修改任何已跟踪文件。

只跑前端 lint：

```bash
npm run lint
```

它只启用 `react-hooks/rules-of-hooks` 与 `react-hooks/exhaustive-deps` 两条规则，并开启 `--report-unused-disable-directives`——`eslint-disable` 必须真的抑制了什么，否则门禁失败。风格类规则一概不开。

> 曾经存在的 `check:scorecard` 已删除：它解析人工填写的产品评分并断言每项大于 8.5，除非有人主动调低自己的评分，否则永远不会失败，属于制造「已被机器验证」表象的假门禁。

公开候选版使用更严格且不允许跳过的发布门禁：

```bash
npm run check:release
```

它额外覆盖协作文档、扫描规模、`clippy -D warnings`、Android 单测/Lint/截图/Debug/无签名 R8，以及从空库回放全部 Supabase migration 后的契约、RLS、RPC、旧签名和 `EXPLAIN` 回归。发布门禁固定使用 Supabase CLI `2.109.1`；缺少 Docker、CLI、Android SDK 或任一门禁资源时会明确失败，不会以 `SKIP` 冒充成功。

### 5. 版本一致性检查

```bash
npm run version:check
```

根目录 `package.json` 的 `version` 是唯一人工维护版本号。桌面端、Rust 后端和 Android APK 都必须与该版本保持一致；桌面和 Android 构建只校验版本，不会自动升版。发布协调员需要升版时显式运行 `npm run release:bump`。详细规则见 `VERSIONING.md`。

### 6. 桌面端构建

```bash
# Debug 安装包
npm run build:debug

# Release 安装包
npm run build
```

构建产物位于 `src-tauri/target/*/bundle/`。

### 7. Android APK 构建

```bash
npm run android:build:debug
npm run android:test
npm run android:verify
node scripts/run-android-gradle.mjs :app:validateDebugScreenshotTest

# unsigned：仅验证 R8/resource shrink，不可分发
node scripts/run-android-gradle.mjs :app:assembleRelease

# signed：需要正式 keystore 与 Supabase 公共配置
node scripts/run-android-gradle.mjs :app:assembleSignedRelease
```

Android 构建会从根版本号写入 `versionName`，并在成功后复制版本化 debug APK 到 `release/TokenLedger_Android_<version>_debug.apk`。截图门禁在主机上验证五份手机 golden 与一份 840dp 平板 NavigationRail golden，但不替代真机触控/TalkBack。普通 release 明确不签名，signedRelease 缺任一正式签名或公共运行配置即失败，绝不回退 debug key；具体配置见 `apps/android/README.md`。

Debug 变体使用 `com.jeidorf.tokenledger.mobile.debug`，正式包使用 `com.jeidorf.tokenledger.mobile`。从 1.2.64 及更早的同包名 Debug 安装迁移到首个正式证书包时必须先卸载并干净安装，本地会话、设置和桌面组件会被清除；云端数据可在重新登录后恢复。正式升级演练必须先验证 1.2.65 与 1.2.66 的 applicationId、版本递增、不可调试和同证书：

```bash
npm run android:verify-upgrade-artifacts -- \
  --private-apk /secure/path/TokenLedger_Android_1.2.65.apk \
  --rc-apk /secure/path/TokenLedger_Android_1.2.66.apk
```

该命令只检查产物，不安装设备。随后再在授权测试设备上执行 1.2.65 干净安装、保留组件与设置、`adb install -r` 升级到 1.2.66、错误证书和降级拒绝测试，并把设备、签名摘要和结果写入任务证据。

### 8. 正式 RC 与制品清单

受保护标签 `v1.2.65` 只生成私有签名演练产物；`v1.2.66` 只有在生产 Supabase 迁移头、macOS Developer ID/公证、Windows Authenticode、Android 正式 keystore 和所有验证引用齐备时才会发布 prerelease。任一变量或签名资源缺失都会在 `.github/workflows/release-rc.yml` 中失败。

每轮构建使用 `release-manifest.schema.json` 和 `scripts/release-manifest.mjs` 生成机器可读清单，记录版本、来源 SHA、构建时间、生产迁移头、平台、架构、文件名、字节数、SHA-256、签名身份、构建环境和证据引用。JSON Schema 描述存储格式；Node 运行时校验器是签名通道、精确公开 RC 四产物矩阵和文件摘要复核的规范门禁。

### 9. 桌面启动参数

macOS release 包可以用 `--show` 绕过持久化的“启动时最小化到托盘”，用于手动打开、排障和窗口验收：

```bash
open -n src-tauri/target/release/bundle/macos/tokenledger.app --args --show

# 已构建 release 包的原生启动可见性 smoke（仅 macOS）
npm run check:native:macos -- --app src-tauri/target/release/bundle/macos/tokenledger.app
```

macOS 原生 smoke 还支持两个用于隔离（quarantine）与人工放行场景的开关：

```bash
# 等待窗口默认 5000 ms；隔离 + 人工走 Gatekeeper「仍要打开」的流程显式放大
npm run check:native:macos -- --app …/tokenledger.app --wait-ms 180000

# 附着到已在运行的实例：不 open、不杀实例，只读窗口并断言
# （人工把放行流程走完后跑，人-paced 环节彻底移出超时面；必须落在断言上）
npm run check:native:macos -- --app …/tokenledger.app --attach --require-visible --wait-ms 180000
```

- `--wait-ms <ms>`：进程出现（或 `--attach` 下实例出现）的等待窗口，默认仍是 5000，只接受 1..3600000 的正整数毫秒；非法值直接报错退出，不静默回退。超时仍是硬失败（退出码 1）并保留既有诊断（探针来源、期望文件是否存在、同类候选进程及未命中原因）。
- `--attach`（别名 `--no-launch`）：不启动、不清理实例，附着到已在运行的实例后按既有语义断言上屏。启动参数口径按 pid 关联两路枚举：路径取 Swift native 探针的 `executableURL.path`，启动参数取 `ps` 的命令行列（native 记录里没有命令行），所以实例是用 `--minimized` / `--show` 拉起时 attach 也照原样断言（`--minimized` → 断言 0 个上屏主窗口；`--show` → 断言主窗口 + ≥1024×680）；两个启动参数同时在场时与 app 侧 `should_start_minimized` 同口径，**`--show` 优先**（断言主窗口）；`ps` 不可用时拿不到启动参数，按「无生效断言」处理。命令行上还可另加 `--require-visible`（要求主窗口存在）与 `--require-active`（要求前台就是该实例，attach 下始终生效）；`--require-visible` 与实例的 `--minimized` 互斥，同时给直接报错。`--attach` 不能与 `--check-single-instance` / `--check-reopen` 同时使用。
- **attach 模式下「没有生效断言」一律失败**：拿不到实例启动参数、且命令行也没给 `--require-visible` / `--require-active` 时，探针报错退出（退出码 1），绝不打印 passed——只报告状态的输出不作为上屏证据。摘要行与 PASS 行都会写出本次**实际生效的断言**（`assertions=…`），不存在无断言绿灯；G2 取证必须落在断言上。
- 无论哪种模式，命中进程后都会先打印 `process match: pid=… kind=… path=…`（`kind` = `exact` / `realpath` / `app-translocation`），再进入等待与窗口读取。**Mac 运行记录必须原样抄下这一行**：它直接回答“批准『仍要打开』之后是否仍被 AppTranslocation”。匹配对隔离与前置包装器（例如 Rosetta 的 `/usr/bin/arch -arm64`）都能命中。**已知窄化**：白名单外的包装器形态（例如 `/usr/bin/env FOO=bar <app>`）仍不命中（判定为不匹配 → 超时硬失败），这是相对旧基线「`command.includes(期望路径)`」的收窄，不是与基线等价；该白名单有意不扩，否则会同时放宽“另一份安装副本、挂载 DMG 必须不命中”的负例面。未命中时诊断会列出同类候选进程及各自的未命中原因；若在真机上撞到包装器形态，按运行记录里的候选列表再加证据重开一轮。

Windows 启动脚本同样支持显式参数：

```bash
start_tokenledger.bat
start_tokenledger.bat --minimized
start_tokenledger.bat --show
```

`--show` 的优先级高于持久化的“启动时最小化到托盘”和 `--minimized`，用于手动启动、支持排障与窗口验收；在 macOS 上还会请求将 TokenLedger 激活到前台；不带参数的启动仍遵循设置页中的启动行为。

---

## 数据与配置路径

应用数据目录由 `src-tauri/src/app_paths.rs` 决定：

| 平台 | 目录 |
| --- | --- |
| Windows | `%APPDATA%\com.jeidorf.tokenledger` |
| macOS | `~/Library/Application Support/com.jeidorf.tokenledger` |
| Linux | `$XDG_DATA_HOME/com.jeidorf.tokenledger`（缺省 `~/.local/share`） |

主要文件：

- `tokenboard.db`：本地 SQLite 数据库
- `app_settings.json`：应用设置
- `cloud_config.json`：Supabase URL 和 publishable key（不保存会话）
- 系统 keyring：Supabase 会话 token
- `prices.json`：自定义模型价格，只存你改过的价格（规则见 `MODEL_PRICING.md`「自定义价格覆盖」）
- `prices.overrides-state.json`：自定义价格文件的格式与哈希记录
- `prices.legacy-backup-*.json`：升级时整理自定义价格前的原文件备份，「恢复默认」不删除
- `prices.migration-notice.json`：升级时整理自定义价格的结果提示与已关闭记录，「恢复默认」不删除
- `models-dev-catalog.json`：models.dev 模型目录缓存，默认 24 小时刷新；刷新失败时可继续使用旧缓存
- `prices.feed.json`：在线更新下载的价格表缓存（修订号比内置表新时作为默认价）
- `prices.feed-state.json`：价格表自动更新开关、上次检查时间与失败原因

---

### 2.0.0 自定义额度凭据兼容

自定义公司额度接口的密钥仅用于保存时绑定的来源（协议、主机和有效端口）。改变来源需重新提供密钥；旧版保存的纯文本钥匙串条目缺少可验证来源，升级后需重新输入一次。此规则只涉及自定义公司额度接口，不改变网关与其他供应商的密钥。设置列表不读取钥匙串，因此重启后密钥状态显示“待检查”；保存新密钥或实际刷新时才核验。Antigravity 本机额度请求禁止重定向。

## Supabase 云端部署

云端部署唯一事实源位于 `supabase/migrations/`，部署和回滚说明见 `supabase/README.md`。`supabase/schema.sql` 只保留为基线/灾难恢复资料，普通用户和常规生产部署不得手工执行它。当前 schema 通过受认证 RPC 暴露数据，不直接向客户端开放聚合物化视图，避免绕过 RLS。

---

## 旧版说明

早期 Node.js + Python Web 仪表盘源码已删除；`legacy/` 目录现仅保留一份未跟踪的本地调试数据库，不代表可运行版本。当前唯一维护版本是根目录下的 Tauri 2 + React + Rust 桌面应用。

---

## 应用标识符

本项目的应用标识符是 `com.jeidorf.tokenledger`（Android 包名为 `com.jeidorf.tokenledger.mobile`）。它同时用于：

- 桌面端数据目录（Windows `%APPDATA%`、macOS `~/Library/Application Support`、Linux `~/.local/share`）
- 系统钥匙串中的凭据条目命名空间
- Tauri 应用 identifier 与 Android applicationId

这个标识符在应用首次发布后**不可更改**——应用商店要求新包名等同于新应用，而已安装用户的本地数据、桌面组件与钥匙串条目都绑定在该标识符上。修改它需要配套的数据迁移，详见下方数据目录一节。

## 隐私

TokenLedger 的一切统计都**先在本机完成**：

- 扫描只读取各 AI 工具自己的日志与数据库目录，不触碰浏览器数据、SSH 密钥、系统钥匙串或其他通用敏感位置。
- 云端同步是**可选**的，默认关闭。开启后只上传按「设备 × 工具 × 模型 × 小时」聚合的行，不含会话 ID、提示词、请求与回复内容、文件路径或凭据。
- 价格表每天联网检查一次更新：只从 `raw.githubusercontent.com` 下载本仓库 `main` 分支的 `src-tauri/prices.json` 与 `prices.meta.json`，不上传任何数据，请求只带应用版本号。可在「设置 → 模型价格 → 每天自动更新价格表」关闭；关闭后只用内置表与已下载的缓存。
- 额度来源需要授权时，只读取你显式开启的本地来源；不复制 OAuth Token，不读浏览器 Cookie，不调用任何消费级产品的未公开内部接口。完整边界见 [额度来源合规说明](docs/design/quota-source-compliance.md)。

## 许可证

本项目以 [MIT 许可证](LICENSE) 发布。选择 MIT 的直接原因是公开分发链路：SignPath Foundation 的免费开源代码签名与 Homebrew Cask 等渠道都以仓库带有 OSI 认可的许可证为前提。

贡献前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md) 与 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。安全问题请按 [SECURITY.md](SECURITY.md) 私下报告，不要开公开 issue。
