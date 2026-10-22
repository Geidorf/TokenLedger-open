# 额度 Provider 能力矩阵与实现研究

> 状态：T10.22b 能力复核 v7 · 核实日期：2026-08-05 · 适用：桌面、Android、壁纸/摆件
>
> 2026-10-17 补录：§2 末三行（供应商余额与实验套餐）按 ADR-018、`docs/contracts/quota-provider-v1.md` §5 与代码补入，官方资料未重新核实；`manual-budget` 与两个 API 组织来源仍无生产者。
>
> 机器字段、状态、不变量、reason code 与 action 语义的唯一事实源是 [`../contracts/quota-provider-v1.md`](../contracts/quota-provider-v1.md)。本文件只记录来源能力、官方资料、当前实现研究与验收现状，不定义第二套 wire contract。

## 1. 结论

TokenLedger 必须把以下三类数据明确分开：

1. **消费者订阅额度**：ChatGPT/Codex 订阅与 Claude Pro/Max 的滚动窗口、周窗口或 credits。
2. **API 组织用量/费用**：OpenAI Platform 或 Claude Console 组织通过 Admin API 产生的 Token 与费用。
3. **企业产品分析**：ChatGPT/Codex 工作区或 Claude Enterprise 的采用率、活动、成本与使用分析。

三者的账户、密钥、计划和数据新鲜度不同，不能相互冒充。消费者订阅仍没有供任意第三方轮询的公开 REST 额度 API；但截至本次复核，两家官方本地客户端已经提供可审计的本地授权来源：

- Codex 官方 `app-server` 的稳定 JSON-RPC 方法 `account/rateLimits/read` 可返回当前已登录 ChatGPT 账户的限流窗口。TokenLedger 仅在用户显式开启后启动本机 `codex app-server --stdio`，完成初始化并读取该方法；不启用 experimental API，也不读取或复用 OAuth Token。旧版 Codex 或 app-server 不可用时，才回退到受限 JSONL `rate_limits` 观察，并明确标记为实验性来源。
- Claude Code 官方 status line 会通过 stdin 向用户配置的命令发送 `rate_limits.five_hour` / `seven_day` 的已用百分比和重置时间。TokenLedger 仅在用户显式开启后，保留这些白名单字段的正规化快照；`~/.claude/settings.json` 只在用户确认预览后改写 `statusLine` 一项（ADR-018，带备份与恢复），不会保存 cwd、session id、transcript path 或原始 stdin。
- 对 Claude 消费者额度，显式授权的增强来源仍有两级，但顺序改为跨平台内置 CLI PTY 优先，依次尝试 Claude Desktop 随附代理与 Claude Code；失败后才以已安装 CodexBar 的标准化 CLI 兜底。同机 2026-07-17 真实证据保留：内置 `/usage` 加载失败时 CodexBar `web` 可返回四个窗口，但这不再使 macOS 外部桥接成为 Windows 的主要依赖。TokenLedger 本身不读取钥匙串/Cookie/OAuth 或网页原始响应，也不直接请求未公开消费者接口。
- Antigravity 采用同一“内置优先、桥接可选”策略。TokenLedger 独立实现 CodexBar 可审计思路：复用同用户 Antigravity App/IDE/agy 的 loopback 服务，或短暂启动已安装 agy PTY；TUI 只排空，额度来自 127.0.0.1 的三个 RPC。CodexBar 兜底仅允许 local/CLI 标准化来源，拒绝 OAuth。2026-07-18 本机真实 App 与 TokenLedger 自启 agy 两条路径都返回 Gemini 5h/周及 Claude/GPT 5h/周四个窗口，未调用 CodexBar且身份字段未进入 envelope。
- OpenAI / Anthropic API 组织用量，以及 Claude Enterprise Analytics，继续作为不同 scope 的后续 Provider；组织密钥不得进入 React、APK、Git 或日志。

因此当前产品策略是：**官方本地协议优先、受控观察仅回退、本地增强逐来源显式授权、企业/API 数据独立建模、不可得时诚实降级**。

## 2. 官方能力矩阵

| Provider ID | 产品范围 | 官方可编程来源 | 认证与前提 | 能得到 | 不能据此得到 | 能力等级 | 当前决策 |
|---|---|---|---|---|---|---|---|
| `openai-codex-local` | ChatGPT/Codex 消费者订阅 | Codex `app-server`：`account/rateLimits/read`；`account/usage/read` 另提供账户 Token 活动摘要 | 本机 Codex 已登录 + TokenLedger 显式 opt-in | 一个或多个 limit bucket 的已用百分比、窗口分钟数、重置时间、plan type；可得时含 credits | 供应商账单、绝对 Token 上限、跨机器实时合并；`account/usage/read` 也不等同额度余量 | 官方路径 `stable`，可用性随账户/计划；JSONL 回退 `experimental` | 已实现官方路径优先；旧版/失败时才受限回退 |
| `company-openapi-<configId>` | 组织内部 API Key 与归属用户费用限额 | `GET /v1/me/quota` | 用户在桌面显式配置 HTTPS 地址与对应 API key；Bearer 认证 | 实测确认 Key 当日消耗/有效上限与归属用户日/月消耗/上限，均为人民币数值；另有余额、Key 过期及限制状态 | 公开 200 schema 仍为空；余额无总额，综合比率、Key 过期与模型限制语义未冻结 | `plan-dependent` | 两条独立已配置端点的只读脱敏探测均为 HTTP 200 且字段/类型一致；已冻结三组金额比率，允许 LKG 与用户二次授权后的标准百分比同步，原始金额/JSON 不离开 adapter |
| `openai-api-organization` | OpenAI Platform API 组织 | Organization Usage / Costs API | OpenAI Admin API key | 按时间、模型、项目、用户/API key 聚合的 API 用量与费用 | ChatGPT/Codex 消费者订阅余量；无预算时不能推导百分比 | `supported` | 后续 Provider 候选，尚未接入产品 |
| `openai-codex-workspace` | ChatGPT Business/Enterprise/Edu 工作区 | Codex Analytics API | 匹配工作区与权限的组织凭据 | 工作区级聚合 Codex 报表 | 个人订阅窗口、通用 Platform 账单上限 | `supported-plan-dependent` | 后续 Provider 候选；能力探测失败不回退私有接口 |
| `anthropic-claude-consumer` | Claude Pro/Max 的 Claude Code 窗口 | Claude Code status line stdin JSON | 用户手工配置 status line + TokenLedger 显式 opt-in；首次 API 响应后才可能出现 | 5 小时/7 天窗口的已用百分比与重置时间；每个窗口可独立缺失 | 可轮询 REST API、完整账单、Team/Enterprise 任意 seat 保证、跨机器实时合并 | `plan-dependent` | 已实现白名单正规化快照；字段缺失时不制造 0 |
| `anthropic-claude-consumer` | Claude Pro/Max，含 Claude 桌面版自用场景 | 用户授权的 CodexBar 标准化 CLI 桥接 | CodexBar 已安装且其 Claude web/OAuth/CLI 来源已授权 + TokenLedger 单独启用 | CodexBar 标准化 JSON 中的 5 小时、每周、模型/功能额度窗口与重置时间 | TokenLedger 不取得或保存 CodexBar 持有的 Cookie/OAuth/钥匙串、账户身份或网页原始响应；API Admin 输出不转为消费者额度 | `experimental` | 已实现固定参数/目录/超时/256 KiB/16 窗口与来源白名单；本机真实 CodexBar `web` 来源已返回 4 个标准化窗口，身份字段已丢弃 |
| `anthropic-claude-consumer` | Claude Pro/Max，含 Claude 桌面版自用场景 | TokenLedger 内置 Claude CLI PTY 主路径；来源发现与解析参考 CodexBar | Claude Desktop 随附代理或 Claude Code 已登录 + TokenLedger 单独启用 | `/usage` 返回的 5 小时、每周与模型百分比窗口，支持 used/left 与相对 reset | 某些计划只返回订阅提示或加载失败；不读取凭据，不保证所有桌面账户都有数值 | `experimental` | 已实现桌面版优先发现、无工具 PTY、全新会话重试与字段白名单；本机 `/usage` 当前诚实返回加载失败，随后可由 CodexBar 兜底 |
| `google-antigravity-consumer` | Antigravity 消费者模型额度 | TokenLedger 内置同用户 App/IDE/agy loopback；来源协议参考 CodexBar 固定提交 | Antigravity/agy 已登录 + TokenLedger 单独启用 | Gemini 与 Claude/GPT 的 5 小时、周等百分比窗口及可信重置时间 | 账户身份、账单、绝对 Token 上限；不使用远端 OAuth | `experimental` | 已实现 App/IDE/已有 agy 发现、自启 agy PTY、loopback only、256 KiB/16 窗口与 LKG；本机两条真实内置路径均返回 4 个窗口 |
| `google-antigravity-consumer` | Antigravity 消费者模型额度 | 可选 CodexBar 标准化 local/CLI 兜底 | CodexBar 已安装 + TokenLedger 额外启用兜底 | CodexBar 标准化 app/cli/ide/local 窗口 | OAuth/远端抓取、账户身份、原始响应 | `experimental` | 已实现固定 `--provider antigravity --source cli`、来源白名单与字段投影；仅在内置路径失败后执行 |
| `anthropic-enterprise-analytics` | Claude Enterprise 产品分析 | Claude Enterprise Analytics API | Enterprise 主所有者启用，Analytics API key（`read:analytics`） | 聊天/Claude Code 活动、采用率；usage-based 计划可得成本与使用 | 个人 Pro/Max 额度；Admin API key 与 Analytics API key 不可互换 | `supported-plan-dependent` | 后续 Provider 候选，尚未接入产品 |
| `anthropic-api-organization` | Claude Console API 组织 | Usage and Cost API | Anthropic Admin API key；个人账户不可用 | 模型/工作区等维度 Token 用量与美元费用 | Claude Pro/Max 消费者窗口；无预算时不能推导百分比 | `supported` | 后续 Provider 候选，尚未接入产品 |
| `manual-budget` | 任意用户自定义预算 | 本地配置 | 无第三方 secret | 用户定义的周期、用量与上限 | 官方权益或官方重置承诺 | `manual` | 设计预留，当前未把手工值伪装成官方额度 |
| `balance-moonshot`、`balance-deepseek`、`balance-openrouter`、`balance-siliconflow` | 供应商 API 账户余额（ADR-018 U-108） | 各供应商官方余额接口 | 用户逐个开启并填入自有 API key（只存钥匙串、只发往该供应商允许列表域名） | 账户余额，`currency` 窗口 | 订阅额度、按模型用量 | `stable` | 已实现（T10.285），真实账户待验 |
| `balance-relay-<configId>` | 网关中转供应商余额 | 用户配置的同源余额地址与取值路径 | 规则同公司 OpenAPI，币种由用户声明 | 余额 | 不推断币种 | `plan-dependent` | 已实现（T10.285），真实账户待验 |
| `zhipu-glm-plan`、`minimax-plan`、`kimi-code-plan` | 编程套餐用量（ADR-018 U-109） | 无公开文档，端点与字段由第三方客户端推断 | 默认关闭，确认风险提示后用用户自有 API key | 可验证的百分比窗口 | 官方承诺的窗口语义 | `experimental` | 已实现（T10.286），真实账户待验 |

“稳定”描述的是官方方法的协议级别，不保证任意版本、账户或计划都返回窗口；运行时仍必须做 capability 探测和错误降级。表中的 `supported` 等词是能力研究分类，不是 wire enum；生产输出必须映射到 v1 契约的 `capability`。每次开发 Provider 或发布大版本前都要复核官方资料。

## 3. 官方来源

### 3.1 OpenAI

- [Codex app-server](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)：stdio JSON-RPC 初始化、`account/rateLimits/read`、`account/usage/read`、窗口字段与 schema 生成方式；额度读取方法不要求 experimental opt-in。
- [Organization Usage API](https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/usage)：组织 API 用量聚合字段与分组能力。
- [Organization Costs API](https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/usage/methods/costs)：组织费用接口与 Admin key 边界。
- [Codex Analytics API overview](https://learn.chatgpt.com/docs/enterprise/analytics-api)：ChatGPT 工作区聚合 Codex 使用；当前 route/schema 以已认证 API reference 为准。

### 3.2 Anthropic

- [Claude Code status line](https://code.claude.com/docs/en/statusline)：status line 命令通过 stdin 接收 JSON；`rate_limits` 仅在 Claude.ai Pro/Max 首次 API 响应后出现，5 小时与 7 天窗口可以分别缺失。
- [Claude Enterprise Analytics API](https://platform.claude.com/docs/en/manage-claude/analytics-api)：Enterprise 计划、Analytics API key、产品活动/采用率与成本使用端点，以及与 Admin API key 的隔离。
- [Claude Usage and Cost API](https://platform.claude.com/docs/en/manage-claude/usage-cost-api)：Claude Console API 组织用量/费用、Admin key、分页与数据新鲜度；个人账户不可用。

### 3.3 外部实现参考（非官方 Provider）

- [CodexBar Claude Provider](https://github.com/steipete/CodexBar/blob/main/docs/claude.md)：Claude Desktop/Code 本地代理发现、CLI PTY `/usage` 交互、used/left 百分比与计划无数值时的诚实降级。TokenLedger 仅参考其公开实现思路并独立实现受限子集，不要求安装 CodexBar，也不复制 CodexBar 的 OAuth/Web/Cookie/Keychain 来源。
- [CodexBar Antigravity Provider（固定提交）](https://github.com/steipete/CodexBar/blob/e6b2ea490cec47d122ba14e32bfc41e53d98422c/docs/antigravity.md)：App/agy/IDE 本地服务发现、三个额度 RPC、PTY 生命周期与诚实降级。TokenLedger 独立重写跨平台受限子集，不复制 OAuth 凭据源，也不把 CodexBar 作为运行必需。
- [CodexBar Provider 架构](https://github.com/steipete/CodexBar/blob/main/docs/provider.md)：用于校验来源规划、fallback 与错误边界；不是 TokenLedger 运行时依赖或稳定上游接口。

### 3.4 组织内部 OpenAPI（自建网关类）

这类来源由**用户所在组织自建**，端点形态与权限语义由该组织决定，不属于任何公开产品文档。适配器按通用契约实现，不绑定具体厂商：

- 端点约定为 `GET /v1/me/quota`，认证使用 `Authorization: Bearer <api-key>`；部分组织会补充个人日/月与 Key 日限额语义。
- 未带 key 的真实 GET 返回 HTTP 401 `invalid_api_key`，只能证明鉴权路径成立，不能证明 200 响应字段。
- 200 response schema 在多数组织侧未声明字段，因此适配器只接受已由夹具固定的字段形态，其余一律拒绝而非猜测。
- 组织特有的响应字段名（成本、限额、过期等）不进入本仓库的能力矩阵公开文本，只保留类型语义描述。

## 4. 机器契约边界

所有 Provider 都必须生产 [`QuotaProviderEnvelope v1`](../contracts/quota-provider-v1.md)。以下内容只在该契约维护：

- TypeScript/Rust/Kotlin/JSON 字段、枚举与必填/可选关系；
- 状态归并、稳定键、百分比/Credits/unlimited、LKG 与兼容不变量；
- 完整 `reasonCode` 注册表、`action` 可选性和安全语义。

本能力文档只回答“官方来源是否存在、需要什么权限、当前实现怎么读取、验证到了哪里”。能力研究变化不能直接改变 wire contract；需要新增字段、枚举或 reason code 时，先修改 v1 契约并补跨端 fixture。

## 5. 当前实现研究

以下是 2026-07-15 的实现快照，不替代 v1 机器契约。

### 5.1 `openai-codex-local` 官方路径

- 默认关闭；用户开启后才允许启动本机 `codex app-server --stdio`。
- GUI 进程即使只有稀疏 `PATH`，也只从显式绝对 `TOKENLEDGER_CODEX_BIN`、绝对 PATH 目录和受控常见位置解析规范化可执行文件。若 npm wrapper 指向 Node 脚本，优先解析随包平台原生 Codex；否则使用规范化绝对 `node` + script，并给子进程构造受控 PATH，不通过 shell 拼接命令。
- 依照官方协议发送 `initialize`、`initialized`，再调用参数为 `null` 的 `account/rateLimits/read`；不声明 `experimentalApi`。
- app-server 单行最多 512 KiB、最多处理 64 条消息、总等待最多 3 秒。Unix 子进程进入独立进程组并整组终止；Windows 使用系统绝对路径下的 `taskkill.exe /T /F`；child wait 与 stdout reader join 均以 250 ms 为界，后代持有 stdout 时也不会无限阻塞命令。stderr 不进入 UI/缓存。
- 只解析 `rateLimits` / `rateLimitsByLimitId` 中可验证的 `primary`、`secondary`、`usedPercent`、`windowDurationMins`、`resetsAt`、`planType` 和可判定 credits；未知字段忽略。百分比必须在 `[0,100]`，window 只接受 1..=11520 分钟，reset 只在本次读取前 5 分钟至读取后 8 天 + 5 分钟内保留；越界 duration/reset 不用于显示荒谬倒计时。Credits 只接受非负有限余额或明确的 unlimited。
- 不读取 Codex OAuth 文件、浏览器 Cookie、prompt、response、thread 内容或账户 Token；不调用修改额度或消费 reset credit 的方法。
- 官方方法成功时 envelope 为 `stable`；账户/计划没有窗口时诚实降级，不用 `account/usage/read` 的活动量冒充额度。

### 5.2 Codex JSONL 回退

- 仅当官方 app-server 路径不可用、超时或当前版本不兼容时尝试；结果必须标记 `capability='experimental'`。
- 根目录只接受 `$CODEX_HOME`，未配置时使用 `~/.codex`；路径规范化后不得越界。
- 在目录条目、深度和总耗时预算内完整枚举 `sessions/**/*.jsonl`，再以 `mtime`、canonical path 的确定性顺序只保留最新 64 个文件读取；找到第 65 个文件本身不报截断。单文件、单行、总字节和候选行预算仍 fail-closed，并在反序列化前筛选包含 `"rate_limits"` 的行。
- 只保留时间、plan type、窗口百分比/时长/重置与可判定 credits；不持久化原始 JSON、session 路径、任务 id、提示词或响应。

### 5.3 `anthropic-claude-consumer` status line

- 默认关闭。桌面设置页通过独立的 `get_claude_statusline_command` 命令和后端 `current_exe` 取得当前安装程序绝对路径，按 Windows/POSIX 规则引用后生成可直接合并进 `statusLine` 对象的 JSON `"command"` 配置项并支持复制；该片段不进入 quota envelope/LKG、不记录或同步，也不下发 Android。它不假设 `tokenledger` 已在 shell `PATH`。依据 ADR-018（U-105、U-106），用户确认改动预览后，TokenLedger 可以写入 Claude Code 用户级 `settings.json` 的 `statusLine` 一项（带备份与一键恢复）；原有 status line 由 helper 记录额度后继续执行并原样输出。T10.282 起设置页提供「一键接入」：预览只含 `statusLine` 的改动（用户目录掩码），确认后按预览版本写入，预览后文件被改即拒绝；备份放在应用数据目录 `quota-claude-backup-v1/`，「恢复原配置」写回接入前文件，接入后文件又被改过需选择强制恢复；目标文件尊重 `CLAUDE_CONFIG_DIR`。原命令存于私有 `claude-statusline-chain-v1.json`，helper 先记录快照，再经 `/bin/sh -c`（Windows 为 `cmd /c`）把同一份 stdin 交给它，限时 2 秒、stdout 最多 4 KiB、不回显 stderr；没有原命令时输出短摘要。手动复制保留为备选。
- helper 只接受有大小上限的一份 stdin JSON，白名单读取 `rate_limits.five_hour/seven_day.{used_percentage,resets_at}`；其他字段不会写入磁盘。
- 5 小时与 7 天窗口可以分别缺失；无合法窗口时不更新快照，不制造 0。重置时间和百分比必须通过范围校验。
- 正规化快照以私有权限原子替换，status line stdout 只输出类似 `Claude 5h 24% · 7d 41%` 的短摘要；不输出路径、会话或原始数据。
- 该能力仅适用于官方说明覆盖的 Claude.ai Pro/Max，且需等待会话首次 API 响应；不是 TokenLedger 可主动轮询的 REST API。

### 5.4 `anthropic-claude-consumer` 内置 CLI PTY 与 CodexBar 兜底

- 默认关闭并与 Claude Code status line 分开授权。开启后先在 macOS Application Support、Windows Roaming/Local 与 Linux config 中发现 Claude/Claude-3p 桌面版随附的最高版本本地代理，并回退到用户 Home、GUI PATH 与 Homebrew 常见位置中的 Claude Code；所有候选必须规范化为可执行普通文件并去重。
- 使用跨平台 PTY 固定执行本地代理 `--allowed-tools ""`，工作目录为 TokenLedger 应用数据 `ClaudeProbe`，`TERM`/`NO_COLOR` 固定；不经 shell，不传提示词，不授予工具，不读取或复制 Claude credential。首次遇到信任提示时，只确认 TokenLedger 自己创建的隔离目录。
- 交互等待启动页后发送 `/usage`，加载期间按有界间隔发送 Enter；总时长 24 秒、输出 256 KiB、120×40 终端、最多 16 个窗口。完成、失败或超时时终止子进程并关闭 PTY，不把 stdout/stderr 原文写入磁盘或 UI。
- ANSI/光标控制正规化后，只解析 `Current session`、`Current week (all models)`、Sonnet/Opus 的百分比；同时支持 `% used` 与 `% left`，相对 reset 需落在七天上界内。账户、组织、成本、Session Token 明细和其他终端字段全部丢弃。成功 envelope 标 `experimental/local-authorized`。
- 内置 PTY 失败后才发现 CodexBar CLI，并以固定 Claude/auto/JSON 参数、TokenLedger 应用数据工作目录、空 stdin、丢弃 stderr、独立进程组、20 秒单次及 24 秒桥接总时限执行。输出上限 256 KiB，只接受 `web/oauth/claude/cli/claude-web` 来源、有效 `updatedAt`、0..100 百分比、8 天内 reset 与最多 16 个唯一窗口。账户/组织/identity/pace/error/source 原文不进入 envelope；两级恢复链合计不超过 44 秒。
- 两级增强来源都失败时，如果 status line 同时启用且存在合法快照则回退；否则合格 LKG 继续按通用规则呈现 stale。CodexBar 缺失/超时/无效响应与内置 PTY 的登录失效、CLI 缺失、加载失败、计划无数值分别使用已注册 reason。

### 5.5 `google-antigravity-consumer` 内置 loopback/agy 与 CodexBar 兜底

- 默认关闭。内置路径先发现同用户 Antigravity App、已有 agy 与 IDE language server；App/IDE 必须从进程参数取得 CSRF，agy 端点不使用 token。进程与端口发现固定使用绝对 `ps/lsof` 或 Windows PowerShell，不执行 shell 字符串。
- 若现有来源均失败，从 TokenLedger/Antigravity 显式绝对覆盖、绝对 PATH 目录与平台已知位置解析 `agy`，以 160×50 PTY 启动。TUI 只由后台 reader 排空、不解析也不持久化；完成/失败/超时只 kill/wait 本次 child，不终止用户原有 agy。
- 请求仅限 `127.0.0.1` 的 RetrieveUserQuotaSummary、GetUserStatus、GetCommandModelConfigs。专用 client 固定 no-proxy，HTTPS 自签名放宽不复用于互联网；完整路径 20 秒、单请求 3 秒、响应 256 KiB、最多 16 个进程/端口/窗口。
- 内置失败后，额外 opt-in 的 CodexBar 兜底固定 Antigravity/cli/JSON 参数；标准化输出只接受 app/cli/ide/local，显式拒绝 oauth。两条路径都只保留去身份的百分比、周期与 reset，能力标 `experimental/local-authorized`。

### 5.6 组织/企业 Provider

- Admin key、Analytics API key 必须按类型分别写入系统钥匙串或受控后端；Android 不直接持有组织 key。
- 前端只提交配置意图，后端只返回不可逆 credential reference；固定官方 HTTPS host allowlist，不允许任意 URL。
- OpenAI/Anthropic API 组织用量与消费者窗口并列但不合并。Claude Enterprise Analytics 与 Claude Admin Usage/Cost 使用不同 key，不能互换。
- 当前仓库只保留这些组织 Provider 的能力候选与安全边界，尚未把它们标为已实现。

### 5.7 用户配置公司 OpenAPI

- 设置页最多保存 5 组稳定配置 ID、名称、URL 与启停状态；API key 以独立账户写入系统凭据库，React 只得到 `hasApiKey`。
- URL 默认补 `/v1/me/quota`，只允许 HTTPS 与 loopback HTTP；禁止凭据、query、fragment 和 redirect。请求固定 Bearer header、5 秒连接/10 秒总时限、256 KiB 响应上限，多个来源并发读取。
- 组织侧 200 schema 仍为空。真实只读探测只保留字段名、JSON 类型、HTTP 状态与两端结构一致性，不保存 URL、key、响应正文或金额值。确认的三组语义映射是：Key 当日消耗 / Key 当日有效上限、归属用户当日消耗 / 归属用户当日上限、归属用户当月消耗 / 归属用户当月上限，均为人民币数值。两值必须同现、有限、非负、上限大于 0 且消耗不超过上限，才换算 percent。
- 每个来源使用稳定的 `company-openapi-<configId>`，capability 为 `plan-dependent`。成功 envelope 可以持久化 LKG，并在用户独立开启 quota transport v2 后上传标准百分比供 Android 展示；云端和 Android 永不接触 URL、key、人民币金额或原始 JSON。余额无总额、当日上限可能为 null、综合比率语义未证实、Key 过期时间与模型级限制对象均未进入 v1，因此都不用于百分比或 reset。

## 6. 当前启停、缓存与失败处理

- Codex、Claude 与 Antigravity 三个 Provider 各自默认关闭；Claude status line、Claude 内置增强、Antigravity 内置读取及其 CodexBar 兜底分别由设置字段控制，启用一个不会授权另一个 Provider。
- 关闭单个 Claude 来源后不再读取它；关闭最后一个 Claude 来源才清除 Provider LKG/停止跨设备同步。Claude status line 即使继续写入正规化输入快照，UI 也必须忽略，直到用户重新开启。
- 为关闭与异步读取并发的撤权竞态兜底，聚合命令在 Provider 完成后重新读取当前设置，清除已禁用来源并把返回值替换为授权必需；Claude helper 写后也重新检查设置，若期间关闭则清理快照并拒绝成功。持久写入与删除使用同一串行锁。
- 每个 `providerId + scope` 最多一个 in-flight refresh；短时间重复请求复用结果，不在 React render 或 Android recomposition 中重复启动来源。
- 通过来源 schema 验证的直接成功 envelope 可持久化为 last-known-good，最长保留 30 天；公司 OpenAPI 的三组已验证金额比率同样适用。超过 30 天、未来时间、provider/scope 不匹配、未知字段或越界值一律拒绝。
- 新观测超过 15 分钟或 reset 已过期时标 `stale`。来源失败时若有合格 LKG，保留原 `observedAt`、更新读取状态并显示失败原因；无 LKG 才返回 `error/auth-required`。
- 正规化快照、LKG 与 `app_settings.json` 使用应用数据目录内的固定文件名、私有原子替换与目录同步；额度文件另有大小上限及符号链接/对象身份检查，Unix 新文件权限为 `0600`。设置不能以截断覆盖方式短暂暴露半份 JSON，否则另一个进程可能把解析失败误判为撤权。
- Provider 失败只影响额度卡，不阻塞主统计。跨机器同步若后续启用，只同步标准化 envelope，不同步凭据、本地路径或原始客户端输入。

## 7. 验收矩阵

| 场景 | 预期 | 当前状态 |
|---|---|---|
| Codex app-server primary + secondary 完整 | 两个窗口的百分比、时长、重置和 plan 正确；capability 为 stable | quota focused 24/24 与 parser 48/48 覆盖；真实账户待验收 |
| Codex `rateLimitsByLimitId` 多 bucket | 稳定 window id，不混合不同 limit | 自动化通过；真实计划样本待验收 |
| GUI 稀疏 PATH / npm wrapper | 只执行规范化绝对路径，优先随包原生 Codex；不依赖交互 shell | resolver 自动化与 Finder 稀疏 PATH 原生 `codex-cli 0.142.4` 探针通过；安装包 GUI 待验收 |
| Codex app-server 无命令/超时/鉴权错误 | 受控 reason；有 LKG 时 stale；不泄露 stderr | 进程树、250 ms wait/reader 边界自动化通过；真实 Windows 进程待验收 |
| Codex app-server duration/reset 越界 | 保留合法百分比语义，但不展示荒谬时长或倒计时 | 自动化通过 |
| Codex app-server 不可用但 JSONL 合法 | 只回退受限事件，capability 明确为 experimental | 自动化覆盖；已有匿名 fixture，不等于真实账户 |
| Codex JSONL 超过 64 个会话 | 有界完整枚举后只读 mtime/path 最新 64 个；不会因第 65 个文件直接失败 | 66 文件自动化通过 |
| Codex JSONL 畸形/巨大/越界 | 跳过或受控错误，无 panic、无原文日志 | 自动化通过 |
| Claude status line 只有一个窗口 | 只保存并展示存在的窗口，不生成另一个零值 | 自动化通过；待真实 Claude Code 验收 |
| Claude status line 两个窗口 | 5h/7d 百分比与重置正确；stdout 仅安全短摘要 | 匿名主二进制探针与自动化通过；待 Pro/Max 实际会话验收 |
| Claude stdin 含 cwd/session/transcript 等字段 | 磁盘只出现白名单正规化字段 | 匿名二进制探针与白名单扫描通过 |
| Claude 输入缺字段、超限、重置越界或快照损坏 | 不更新有效快照；返回明确 reason；不输出原文 | 自动化通过 |
| CodexBar 真实 Claude 消费者来源 | 只接收标准化窗口，拒绝 API Admin scope，丢弃账户/组织/pace/原始来源字段 | 本机 CodexBar CLI `0.42.1` 真实 `web` 来源返回 5 小时、全模型每周、Daily Routines 与模型每周共 4 个窗口；忽略式真实账户 Rust 门禁通过 |
| CodexBar 缺失、超时、非 Claude/API scope、超 16 窗口或重复 ID | 受控 reason；内置 PTY 已先执行；合格 LKG 保持 stale | 固定参数真实子进程、parser 与前端静态契约通过 |
| Claude 合成 PTY used/left 输出 | 5h/7d/模型窗口进入 experimental envelope；账户与终端原文不进入输出 | 合成 parser 3 组与真实 PTY 往返测试通过 |
| Claude Desktop 随附代理与 Claude Code 候选 | 桌面版最高版本优先，候选必须为规范化可执行文件；不访问 Keychain | 本机发现桌面版 `2.1.142` 与 Claude Code `2.1.211`；生产路径优先桌面版，真实 `/usage` 当前均诚实返回加载失败 |
| PTY 超时、输出越界、计划无数值或登录失效 | 24 秒预算内返回注册 reason；终端原文/账户信息不进入 UI/LKG/日志，合格 LKG 保持 stale | parser/边界与合成 PTY 自动化通过；真实来源恢复后待平台验收 |
| 用户未安装 CodexBar | 不索取凭据；Claude 与 Antigravity 仍使用各自内置主路径 | 候选空集、失败分类与内置路径自动化通过 |
| Antigravity App 同用户 loopback | CSRF 只留在进程内；专用 no-proxy client 只请求 127.0.0.1，输出不含账户身份 | 2026-07-18 macOS 真实 App 读取通过，4 个窗口；Windows 真实进程待外部验收 |
| Antigravity App 不可用但 agy 已安装 | 规范化绝对路径、PTY 只排空、端点就绪后读取，结束仅回收本次 child | 2026-07-18 macOS 真实自启 agy 读取通过，4 个窗口；自动化 parser/生命周期通过 |
| Antigravity CodexBar 兜底 | 只接受 app/cli/ide/local；`oauth` 与未知来源 fail closed | 合成标准化 parser 与 OAuth 拒绝测试通过；真实 CLI 已作参考对照，不作为内置实测来源 |
| 应用重启后来源暂不可用 | 30 天内合格 LKG 变 stale；超期后拒绝 | 自动化通过 |
| 用户在读取/写入期间关闭 Codex/Claude/Antigravity | 完成后复核授权，不返回已撤权数据；内存、输入快照和 LKG 清除或忽略 | 竞态与原子设置自动化通过；待真实多进程 UI 复核 |
| 公司 OpenAPI key 缺失、被拒绝或系统凭据不可读 | `auth-required/error`；React/APK 只见状态，拿不到 secret | 自动化覆盖缺 key/安全边界；真实系统凭据与有效 key 待验 |
| 公司 OpenAPI 三组人民币消耗/额度上限 | 生成 Key 日、用户日、用户月 `plan-dependent` 百分比窗口；多个配置稳定分开；允许 LKG 与二次授权后的同步 | 两条真实已配置端点均 HTTP 200 且字段/类型一致；Rust parser/真实 loopback HTTP、同步投影与前端契约通过；真实安装包展示待验 |
| 公司 OpenAPI 字段缺半、超限、巨大、重定向或未知结构 | fail closed，不 clamp、不记录正文；余额、综合比率、Key 过期与模型状态不冒充百分比/reset | 自动化覆盖；真实上游异常样本待验 |
| 公司 OpenAPI 429、缺 key 停用与本机配置已删但云端仍在 | 遵循 `Retry-After`/持久退避；停用无需现存 key；云端孤立 Provider 可单独删除 | Rust 与前端回归通过；真实上游 429、系统凭据和云端删除交互待安装包验收 |
| 额度卡已知/未知上限 | 已知窗口显示百分比；余额显示 Credits 剩余；unlimited 显示无限；后两者不绘制假进度 | 前端双时区 34/34 契约覆盖；真实 Provider 视觉待平台复核 |
| 设置/错误辅助信息 | 当前安装程序 JSON `"command"` 配置项可复制，reason code 本地化，开关以 `aria-describedby` 关联 hint | 前端双时区 34/34 契约覆盖；键盘/读屏待平台验收 |

### 7.1 额度 UI 证据边界

下表登记的是**内容寻址证据的哈希**：截图本身按项目规则不入库（见 `docs/task-logs/README.md` 的证据格式约定），因此在本仓库中无法直接查看图像，只能凭哈希核对内容一致性。证据文件保存在维护方的内部仓库，不随本仓库发布（见 [`../internal-collaboration-materials.md`](../internal-collaboration-materials.md)）。

| 开发 fixture（文件不在本仓库） | SHA-256 | 证明范围 |
|---|---|---|
| `docs/task-logs/T3.3/evidence/20260715-codex-claude-local-authorized-1280x720.jpg` | `e6e17f7f30e7c883f519f071b640666095620daf0620f53270ac8d4dba5c84f4` | 1280×720 趋势优先层级及两张 Provider 卡的 React 呈现 |
| `docs/task-logs/T3.3/evidence/20260715-codex-claude-local-authorized-all-windows-1280x720.jpg` | `f0c795ce2fc4d3ebfd24b34544d802b3402cf3b74fa660639f3854ef99dd70a4` | 四个 Codex/Claude fixture 窗口完整呈现 |
| `docs/task-logs/T3.3/evidence/20260715-codex-credits-and-claude-windows-1280x720.jpg` | `55b0d6d144af9d562d4f9bebf09ae6e1d0d6f170c36d1c1464595ace8b285427` | Codex 百分比窗口、Credits 绝对余额与 Claude 5h/7d 同画布呈现 |
| `docs/task-logs/T3.3/evidence/20260715-quota-settings-full-command-1280x720.jpg` | `4d169a9382c412696e9277213008e00de36da942e41881221a45f2fa2bb181e6` | 完整 Claude JSON `"command"` 配置项与复制动作的 React 呈现 |

四张图全部是确定性开发 fixture，不是当前安装程序调用或真实 Codex/Claude 账户证据；真实 Provider、macOS/Windows 进程和辅助技术仍按发布门禁单独验收。

## 8. 发布门禁

1. parser/protocol/contract 测试只使用匿名 fixture，不提交真实 session、status line 原文或真实组织 key。
2. 对日志、缓存、二进制输出与截图做敏感字段扫描；不得出现 OAuth Token、Cookie、cwd、session id、transcript path、原始响应或 request body。
3. 额度卡显示 scope、source/capability、`observedAt` 与 stale 原因；Codex JSONL 回退必须有实验性标签。
4. macOS 与 Windows 分别验证本地子进程、文件权限/ACL、休眠恢复、禁用清理与持久 LKG；Android 验证 APK 不含组织 key。
5. 使用真实登录账户、真实 Claude Code 与真实企业/API 凭据的项目必须单独记录；没有凭据时不得把 fixture、mock 或编译通过写成端到端完成。
6. 官方资料复核日期写入 release task log；上游契约变化通过 Provider 版本和迁移说明发布。
