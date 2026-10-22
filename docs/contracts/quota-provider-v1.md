# TokenLedger Quota Provider Contract v1

> 状态：Active ｜ schemaVersion：`1` ｜ 建立：2026-07-15 ｜ 最近修订：2026-10-04（ADR-018：门控货币单位、供应商余额与实验套餐来源；实现见 T10.284～T10.286；余额上云、原因码登记与币种显示见 T10.288）
>
> 本文件是 Rust、React、云端同步与 Android 的额度机器契约。来源可用性、官方资料与实现研究见 [`../integrations/quota-provider-capabilities.md`](../integrations/quota-provider-capabilities.md)；两者冲突时，机器字段与不变量以本文件为准。

## 1. 作用域

额度数据与 TokenLedger 扫描得到的 Token 消耗是两条事实链。消费者订阅窗口、API 组织用量和手工预算不得互相替代或合并成一个“剩余额度”。Provider 每次返回一个 envelope；同一 Provider 可在 `windows` 中返回多个独立窗口。

```ts
type QuotaScope =
  | 'consumer-subscription'
  | 'api-organization'
  | 'manual-budget';

type QuotaSource = 'official-api' | 'local-authorized' | 'manual';
type QuotaMode = 'automatic' | 'manual' | 'unsupported';
type QuotaCapability =
  | 'stable'
  | 'plan-dependent'
  | 'experimental'
  | 'manual'
  | 'unsupported';
type QuotaStatus = 'ok' | 'stale' | 'unsupported' | 'auth-required' | 'error';
type QuotaWindowStatus = Exclude<QuotaStatus, 'unsupported'>;
type QuotaUnit =
  | 'percent' | 'requests' | 'tokens' | 'usd' | 'credits'
  | 'currency'; // 门控扩展（2026-10-04），只发给声明支持的读取方，见 §2.2、§6.1、§7
type QuotaActionKind = 'open-url' | 'open-settings' | 'show-command';

interface QuotaAction {
  kind: QuotaActionKind;
  labelKey: string;
  value: string;
}

interface QuotaWindowSnapshot {
  providerId: string;
  windowId: string;
  windowLabel: string;
  accountLabel?: string;
  scope: QuotaScope;
  source: QuotaSource;
  status: QuotaWindowStatus;
  used?: number;
  limit?: number;
  remaining?: number;
  unit: QuotaUnit;
  currency?: string; // ISO 4217 大写三字母，仅且必须与 unit='currency' 同现
  windowMinutes?: number;
  resetsAt?: string;
  observedAt: string;
  fetchedAt: string;
  staleAfterSeconds: number;
  reasonCode?: string;
}

interface QuotaProviderEnvelope {
  schemaVersion: 1;
  providerId: string;
  displayName: string;
  scope: QuotaScope;
  mode: QuotaMode;
  capability: QuotaCapability;
  status: QuotaStatus;
  windows: QuotaWindowSnapshot[];
  reasonCode?: string;
  action?: QuotaAction;
}
```

所有时间字段是含时区的 RFC 3339 字符串；数值必须是有限数。字段名在 JSON 中使用 camelCase，枚举值使用上面的 kebab-case 字面量。

## 2. 字段语义与不变量

1. `providerId + scope + windowId` 是窗口稳定键；显示名、顺序、账户标签或本地化文案不能作为标识。
2. `observedAt` 表示上游产生或本地授权来源观察到数据的时间，`fetchedAt` 表示 TokenLedger 返回本次 envelope 的时间。读取 last-known-good（LKG）时保留原 `observedAt`，不得伪造成新观测。
3. `staleAfterSeconds` 由 Provider 定义，且必须是有限正数。超过新鲜度、reset 已过期或新读取失败但仍有合格 LKG 时，相关窗口和 envelope 标记 `stale`；不得清零旧值。
4. `unit='percent'` 时，`used` 表示已用百分比，必须位于 `[0,100]`，`limit` 若存在必须为 `100`。只有上游直接给出百分比，或同一单位的 `used` 与 `limit` 可验证时，UI 才能绘制进度。
5. 非百分比窗口的 `used`、`limit`、`remaining` 必须使用同一 `unit`；若三者同时存在，允许浮点误差范围内满足 `remaining = limit - used`。负数、不一致或非有限值使该窗口 fail closed。
6. 只有 Credits 余额时使用 `unit='credits'` 与 `remaining` 的绝对值。来源明确 unlimited 时仍可返回稳定的 Credits window，但不构造数值；该 window 使用 `reasonCode='credits_unlimited'`，UI 显示“无限 Credits”，不画进度。
7. API 组织只提供 Token/美元使用量而无可验证预算时，仅返回绝对值，不创建 `limit=100` 或消费者订阅窗口。
8. `status='unsupported'` 时 `windows` 必须为空，`mode/capability` 均为 `unsupported`，并提供已注册、可本地化的 `reasonCode`；`action` 仍是可选字段，window 不允许 `unsupported` 状态。
9. envelope 的 `scope` 与每个窗口的 `scope` 必须一致。`mode='manual'` 只允许 `source='manual'`；本地授权来源使用 `source='local-authorized'`。
10. `reasonCode` 是稳定机器键，UI 负责本地化。`stale/auth-required/error` 应提供已注册的 reason code；为兼容现有 v1 类型仍保持可选，缺失或未知时消费者使用安全通用文案，不把它解释成上游原文。
11. `action` 对所有状态都可选，包括 `unsupported`。只有存在安全、明确、用户可执行的恢复动作时才应返回；没有动作是合法状态，客户端不得自行猜测 URL、命令或设置目标。
12. `action.labelKey` 是本地化键。`action.value` 只能是受控设置目标、允许列表 URL 或用户可见的本地配置命令；不得携带 Token、Cookie、可复用凭据、上游正文、stderr、异常堆栈或用户隐私路径。
13. `source='official-api'` 表示**用户自己的凭据发往供应商自家的允许列表域名**（或用户为中转站显式配置的同源地址）。该接口是否有公开文档由 `capability` 表达：有公开文档或经两条独立实测冻结的用 `stable`/`plan-dependent`，无公开文档的必须用 `experimental`。复用消费者订阅登录凭据（OAuth、refresh token、钥匙串、Cookie）得到的数据不得使用任何 source 值进入 envelope（ADR-004、ADR-018）。

### 2.1 Action 执行边界

- `open-settings`：`value` 必须是客户端内置 allowlist 中的设置目标；未知值忽略 action，不降级为任意路由。
- `open-url`：只允许 Provider 固定的 HTTPS host/path allowlist；不得接受上游返回的任意 URL，也不得在 query/fragment 中附带凭据。
- `show-command`：只用于展示/复制契约 allowlist 中的供应商命令；当前生产 allowlist 只有 Claude `/usage`。客户端不得自动交给 shell 执行。桌面设置页生成的 Claude status-line 配置片段走独立、显式的设置命令，不进入 quota envelope，也不属于 `QuotaAction`。
- action 无效或当前平台不支持时，只隐藏动作并保留 reason 文案；不能因此把 envelope 改成 `ok`，也不能阻塞主统计。

### 2.2 货币单位 `currency`（门控扩展）

1. `unit='currency'` 表示某种法定货币的绝对金额，币种由 `currency` 给出（ISO 4217 大写三字母，正则 `^[A-Z]{3}$`，例如 `CNY`、`USD`）。`unit='currency'` 时 `currency` 必填；其他单位下出现 `currency` 视为无效窗口。既有 `unit='usd'` 保留原语义，新生产者表达美元余额时使用 `currency` + `USD`，不再新增 `usd` 窗口。
2. 余额窗口只填 `remaining`（≥ 0 的有限数）；只有上游同时给出同币种的明确消费上限时，才可填 `limit`/`used`，并遵守不变量 5。没有上限时 UI 不画进度，只显示金额与币种。
3. 同一 Provider 的不同币种是不同窗口，`windowId` 固定为 `balance-<小写币种>`（例如 `balance-cny`）。不得在生产端做汇率换算，也不得把不同币种相加。
4. 余额窗口不设 `windowMinutes`、`resetsAt`，`staleAfterSeconds` 由 Provider 定义（建议 3600）。`reasonCode='credits_unlimited'` 不适用于货币窗口。
5. 读取方显示金额千分位用逗号，`JPY` 取整、其余保留两位小数：`CNY`、`USD`、`EUR`、`GBP`、`JPY` 分别写作符号前缀 `¥`、`$`、`€`、`£`、`JP¥`（例如 `¥1,234.50`、`JP¥1,200`），其他代码（包括未知代码）写成「金额 + 空格 + 代码原文」（例如 `7.00 HKD`），不猜符号（T10.288，桌面设置页、看板与 Android 同规则，以 `balance-v1.json` 的 `display` 为准）。遇到无法识别的 `unit`，**只丢弃该窗口**并保留同 envelope 的其他窗口，不再让整个 envelope fail closed（新版读取方必须实现；旧版读取方的保护见 §6.1 与 §7）。

## 3. Envelope 状态归并

| 条件 | Envelope 状态 |
|---|---|
| 至少一个可信新鲜窗口，且没有阻断整体读取的错误 | `ok` |
| 仅有合格 LKG、上游观测过期或部分关键窗口过期 | `stale` |
| 来源需要用户登录、授权或显式启用 | `auth-required` |
| 来源应可用但本次无法安全读取，且无合格 LKG | `error` |
| 当前计划/平台没有受支持的读取来源 | `unsupported` |

多窗口允许分别缺失；例如 Claude 只返回 5h 窗口时，不得补一个 7d 零值。窗口顺序不承载语义，消费者按稳定键关联与排序。

Claude 的 5h 与 7d 是两个规范角色，不把某个来源返回任意非空窗口解释成整个 Provider 完整。多个已授权本地来源同时存在时允许按角色补齐与仲裁：只考虑 `ok/stale` 窗口；同角色冲突按 status line、标准化 CodexBar、内置 PTY 的来源置信度依次选择，再比较窗口新鲜度、`observedAt` 与 `fetchedAt`。获胜窗口必须原样保留来源稳定键和时间，不能用本次仲裁时间刷新观测。Sonnet/Opus 等附加窗口独立保留，不得冒充规范 7d 角色。该规则只规范同一 v1 envelope 的生产与合并，不增加 wire 字段。

## 4. Reason code 注册表

下表是 v1 `QuotaProviderEnvelope.reasonCode` 与 `QuotaWindowSnapshot.reasonCode` 允许使用的完整注册表。Producer 不得把任意上游错误字符串塞入 `reasonCode`；新增 code 必须先在此登记、补 UI 本地化和跨端 fixture。因为字段本身可选且读者可安全忽略未知 code，增加已登记 code 可保持 schemaVersion 1；若新 code 改变状态或字段语义，则必须升级 schemaVersion。阶段为“预留”的 code 在本地化和 fixture 合入前不得由生产 Provider 发出。

| Code | 允许载体 / 典型状态 | 含义 | 安全默认呈现或恢复动作 | 阶段 |
|---|---|---|---|---|
| `local_authorization_required` | envelope / `auth-required` | Codex 本地 Provider 默认关闭或授权已撤销 | 解释只读范围；可选 `open-settings` | 已实现 |
| `app_server_unavailable` | envelope / `error`；LKG 时 envelope/window `stale` | 本机 Codex 不支持、无法启动或 app-server 与受限回退均无可信值 | 显示 LKG 或检查版本/设置 | 已实现 |
| `app_server_timeout` | envelope / `error`；LKG 时 envelope/window `stale` | app-server 在有界时间内未返回 | 显示 LKG；允许安全重试 | 已实现 |
| `app_server_auth_required` | envelope / `error` 或 `auth-required`；LKG 时 `stale` | 本机 Codex 未登录或账户没有可读取窗口 | 引导在 Codex 登录，不索取凭据 | 已实现 |
| `consumer_api_unavailable` | envelope / `unsupported` | 消费者订阅没有可供第三方轮询的公开 REST API，且当前没有可用本地授权来源 | 解释边界；可选官方用量入口或配置动作 | 兼容保留 |
| `source_not_found` | envelope / `error`；LKG 时 envelope/window `stale` | 允许范围内未找到本地来源 | 检查显式配置，不扩大扫描范围 | 已实现 |
| `permission_denied` | envelope / `error`；LKG 时 envelope/window `stale` | 允许的本地来源不可读 | 检查本地权限，不请求额外凭据 | 已实现 |
| `secure_storage_unavailable` | envelope / `error`；LKG 时 envelope/window `stale` | 已配置的公司额度 API key 无法从系统安全存储读取 | 告知后台不会重复读取；确认钥匙串已解锁后明确点击刷新额度 | 已实现 |
| `source_schema_unsupported` | envelope / `error`；LKG 时 envelope/window `stale` | 官方响应或实验回退事件无法安全解析 | 显示升级/刷新建议；不猜字段 | 已实现 |
| `source_scan_truncated` | envelope / `error`；LKG 时 envelope/window `stale` | 受限扫描达到目录、字节、行数或时间预算，无法证明结果完整 | 显示 LKG 或安全重试，不返回部分结果冒充完整 | 已实现 |
| `source_temporarily_unavailable` | envelope / `error`；LKG 时 envelope/window `stale` | 本地来源瞬时失败 | 显示 LKG 并允许退避重试 | 已实现 |
| `provider_worker_failed` | envelope / `error`；LKG 时 envelope/window `stale` | Provider worker 未能返回可信结果 | 通用受控错误；不传 panic/stderr | 已实现 |
| `provider_cache_unavailable` | envelope / `error` | Provider 缓存无法安全读取且没有可用结果 | 通用受控错误；允许重新读取来源 | 已实现 |
| `claude_local_authorization_required` | envelope / `auth-required` | Claude 本地来源全部关闭或授权已撤销 | 解释 status line / 内置增强两档来源；可选 `open-settings` | 已实现 |
| `claude_statusline_snapshot_missing` | envelope / `error` | 尚未收到含 `rate_limits` 的官方 status line 输入 | 引导完成一次 Claude Code API 请求后重试 | 已实现 |
| `claude_statusline_snapshot_invalid` | envelope / `error` | 正规化快照越界、损坏、过期或身份检查失败 | 检查配置并重新触发 status line | 已实现 |
| `claude_native_authorization_required` | envelope / `auth-required`；LKG 时 `stale` | Claude 本地代理明确返回登录失效或需要重新登录 | 引导在 Claude Desktop/Code 中登录后重试 | 已实现 |
| `claude_native_cli_unavailable` | envelope / `error`；LKG 时 `stale` | 未发现 Claude Desktop 随附代理或本机 Claude Code | 引导安装/启动并登录 Claude；不要求 CodexBar | 已实现 |
| `claude_native_timeout` / `claude_native_usage_unavailable` | envelope / `error`；LKG 时 `stale` | PTY 超时或 Claude CLI 的 `/usage` 通道自身加载失败；Claude Desktop 网页额度可能同时正常 | 保留 LKG；换用其他本地候选并以全新会话有界重试，失败不缓存；不读取钥匙串 | 已实现 |
| `claude_native_subscription_unavailable` | envelope / `error`；LKG 时 `stale` | 当前计划仅返回订阅提示，没有可量化的 5h/周窗口 | 诚实显示计划未提供数值，不从 Token 活动量估算 | 已实现 |
| `claude_native_response_invalid` | envelope / `error`；LKG 时 `stale` | 输出超限、百分比/重置越界或没有合法窗口 | 不保存终端原文；保留 LKG 并提示来源异常 | 已实现 |
| `claude_codexbar_unavailable` / `claude_codexbar_timeout` / `claude_codexbar_response_invalid` | envelope / `error`；LKG 时 `stale` | 用户授权的 CodexBar 标准化桥接缺失、超时或没有返回可验证的 Claude 消费者窗口 | 保留 LKG；检查 CodexBar Claude 来源授权或使用内置 PTY 回退，不向 TokenLedger 索取凭据 | 已实现 |
| `antigravity_local_authorization_required` | envelope / `auth-required` | Antigravity 本地来源默认关闭或授权已撤销 | 解释 loopback/CLI 只读边界；可选 `open-settings` | 已实现 |
| `antigravity_native_authorization_required` | envelope / `auth-required`；LKG 时 `stale` | 本地服务明确拒绝访问或 Antigravity 登录不可用 | 引导在 Antigravity 中完成登录，不索取凭据 | 已实现 |
| `antigravity_native_source_not_found` / `antigravity_native_port_unavailable` | envelope / `error`；LKG 时 `stale` | 未发现同用户 App/IDE/agy，或其 loopback 监听端口不可用 | 启动/登录 Antigravity 或安装 agy；不扩大到远端 OAuth | 已实现 |
| `antigravity_native_timeout` / `antigravity_native_response_invalid` | envelope / `error`；LKG 时 `stale` | 本地服务超时、响应越界或没有合法额度窗口 | 保留 LKG；有界重试，不记录 RPC/TUI 原文 | 已实现 |
| `antigravity_codexbar_unavailable` / `antigravity_codexbar_timeout` / `antigravity_codexbar_response_invalid` | envelope / `error`；LKG 时 `stale` | 可选 CodexBar local/CLI 兜底缺失、超时或返回非本地/无效窗口 | 保留 LKG；继续使用内置路径，不向 TokenLedger 索取 OAuth | 已实现 |
| `observation_stale` | envelope/window / `stale` | 当前仅有历史快照或窗口已过新鲜期/reset | 显示原 `observedAt` 与刷新动作，不清零 | 已实现 |
| `reset_elapsed` | envelope/window / `stale` | 来源仍新鲜但该窗口 reset 时间已过 | 保留原观测并等待来源刷新，不清零 | 已实现 |
| `credits_unlimited` | Credits window / `ok` 或 `stale` | 来源明确声明 Credits 不设固定上限 | 显示“无限 Credits”，不画进度条 | 已实现 |
| `admin_key_required` | envelope / `auth-required` | 组织 Provider 缺少对应类型的 Admin/Analytics key | 可选打开安全凭据设置；前端/APK 不接触 key | 预留 |
| `api_key_required` | envelope / `auth-required` | 用户配置的公司 OpenAPI Provider、供应商余额或实验套餐来源缺少 key，或上游拒绝当前 key | 引导到本机额度或供应商设置；前端/APK/云端不接触 key | 已实现（余额与实验套餐复用时随 T10.285/T10.286 补本地化） |
| `experimental_consent_required` | envelope / `auth-required` | 实验性来源（ADR-018 U-109）尚未确认风险提示，或风险提示版本已提升需重新确认 | 引导到设置页查看风险并确认；不自动读取 | 已实现（T10.286，`quota/balance/experimental.rs`）；同步白名单尚未登记，见 §6.1 末条 |
| `balance_unavailable` | envelope / `error`；LKG 时 envelope/window `stale` | 余额接口返回成功但没有可验证的金额或币种 | 显示 LKG；不猜币种、不补零 | 已实现（T10.285 生产，T10.288 登记同步白名单与桌面/Android 本地化） |
| `rate_limited` | envelope / `error`；LKG 时 envelope/window `stale` | 官方组织 API 返回限流 | 显示 LKG 并遵循 Retry-After/退避 | 已实现 |
| `upstream_unavailable` | envelope / `error`；LKG 时 envelope/window `stale` | 官方组织 API 网络错误或 5xx | 显示 LKG 与受控服务不可用文案 | 已实现 |

`claude_statusline_input_unavailable`、`claude_statusline_input_invalid`、`claude_statusline_snapshot_not_updated` 等 helper/命令层退出字符串不属于 envelope/window `reasonCode`，不得直接传给 React/Android。若未来需要进入 wire contract，必须先登记为新的 reason code，并补本地化、脱敏与 fixture。

## 5. Provider 映射

| Provider | scope / source | capability | 契约要求 |
|---|---|---|---|
| `openai-codex-local` app-server | `consumer-subscription` / `local-authorized` | `stable` | 用户显式启用后，通过官方文档支持的本地 app-server 读取一个或多个窗口；不得读取 OAuth 文件或网页 Cookie |
| `openai-codex-local` JSONL fallback | `consumer-subscription` / `local-authorized` | `experimental` | 仅在官方路径不可用时受限读取白名单字段；UI 必须显示实验来源，不同步原始路径/内容 |
| `anthropic-claude-consumer` status line | `consumer-subscription` / `local-authorized` | `plan-dependent` | 用户显式配置并启用；5h/7d 窗口独立可缺失，不把 status line 输入当可轮询 REST API |
| `anthropic-claude-consumer` CodexBar 标准化桥接 | `consumer-subscription` / `local-authorized` | `experimental` | 用户单独启用并在 CodexBar 中授权来源；TokenLedger 以规范化绝对路径、固定参数/工作目录/超时/输出上限启动 CLI，只接受标准化 Claude 消费者 JSON 并拒绝 API 组织 scope；不读取或保存 CodexBar 持有的 Cookie/OAuth/钥匙串或原始响应 |
| `anthropic-claude-consumer` built-in CLI PTY | `consumer-subscription` / `local-authorized` | `experimental` | 用户单独启用；TokenLedger 参考 CodexBar 的 CLI PTY 思路，依次尝试 Claude Desktop 随附代理与本机 Claude Code，失败后以全新会话有界重试；只在额度标题至下一标题的有界区间解析 `/usage` 百分比，截断重绘不得串用相邻窗口；不要求安装 CodexBar，不读取 Cookie/OAuth/钥匙串或调用未公开消费者 API |
| `google-antigravity-consumer` built-in loopback/agy | `consumer-subscription` / `local-authorized` | `experimental` | 用户单独启用；发现同用户 App/IDE/agy 或短暂启动规范化绝对路径 agy，只请求 127.0.0.1 的额度/状态 RPC；专用 client 才允许本地自签名证书，TUI 不解析，账户身份丢弃，且只回收自己启动的 child |
| `google-antigravity-consumer` CodexBar local fallback | `consumer-subscription` / `local-authorized` | `experimental` | 用户额外启用且已安装 CodexBar 时，仅在内置路径失败后以固定 `antigravity + cli` 参数读取标准化 JSON；只接受 app/cli/ide/local source，拒绝 oauth 与账户身份 |
| OpenAI/Anthropic API organization（预留，尚无生产者） | `api-organization` / `official-api` | `stable` 或 `plan-dependent` | 只使用对应官方组织凭据；消费者订阅与组织 usage/cost 不互换 |
| `company-openapi-<configId>` | `api-organization` / `official-api` | `plan-dependent` | 用户可配置最多 5 个命名 HTTPS 来源；key 仅进系统安全存储。两条独立实测 HTTP 200 响应确认相同字段/类型后，只按同一人民币单位换算三类 `percent` 窗口：`key_day_cost_cny / key_daily_limit_effective_cny`、`user_quota.day_cost_cny / user_quota.day_limit_cny`、`user_quota.month_cost_cny / user_quota.month_limit_cny`。成功结果可写 LKG，并在第二层同步授权开启后进入既有 owner-bound v2；金额、余额、URL、key 与原始 JSON 不得进入 envelope/云端。余额无总额、上游综合比率含义未公开、Key 过期不等于额度 reset，均不得猜测 |
| `manual-budget`（预留，尚无生产者；同步层已能校验） | `manual-budget` / `manual` | `manual` | 明确标为用户配置，不冒充供应商权益或官方 reset 承诺 |
| `balance-moonshot`、`balance-deepseek`、`balance-openrouter`、`balance-siliconflow`（ADR-018 U-108，已实现，T10.285） | `api-organization` / `official-api` | `stable` | 用户逐个开启；key 只存钥匙串、只发往该供应商的固定允许列表域名；输出 §2.2 的 `currency` 余额窗口，不画进度、不换汇；不得返回账户身份或原始响应 |
| `balance-relay-<configId>`（已实现，T10.285） | `api-organization` / `official-api` | `plan-dependent` | 用户为网关中转供应商配置的同源余额地址与取值路径；规则同公司 OpenAPI（HTTPS、禁止重定向与 URL 凭据、响应上限），币种由用户显式声明，不从响应猜测 |
| `zhipu-glm-plan`、`minimax-plan`、`kimi-code-plan`（ADR-018 U-109，已实现，T10.286） | `consumer-subscription` / `official-api` | `experimental` | 默认关闭，确认风险提示后才读取；只用用户自己的 API key 发往供应商自家域名；只输出可验证的百分比窗口（`windowMinutes`、`resetsAt` 可得时填写），不预测速度；禁止订阅登录 OAuth 与网页会话 |

具体方法、计划限制、刷新预算与官方链接由能力矩阵维护；能力变化不能静默改变本契约字段语义。

## 6. 安全与生命周期

- 消费者本地 Provider 默认关闭并逐来源 opt-in；授权范围在设置页可解释、可撤销、只读。关闭最后一个同 Provider 来源后停止新读取，清理或忽略内存/LKG，并在异步结果写回前再次校验授权代次。
- Quota Provider 结果只以标准 envelope 交给 React/Android，不携带组织 secret、本地凭据、Cookie、原始 session、cwd、transcript、提示词、响应或来源路径。桌面设置页可通过独立 `get_claude_statusline_command` 取得仅包含当前 TokenLedger 可执行文件路径的转义配置片段，供用户可见地复制；依据 ADR-018（U-105、U-106），也可经独立设置命令预览并写入 Claude Code `settings.json` 的 `statusLine` 一项（带备份与恢复），用户原有的 status line 命令保存在本机私有文件中，由 helper 继续执行。配置片段、原命令与备份都不写入 envelope/LKG、不同步、不进日志，也不下发 Android。
- 用户授权本地增强时，TokenLedger 不得直接读取第三方 Cookie/OAuth/钥匙串或调用未公开消费者 API。允许执行由用户另行安装并授权的 CodexBar 外部桥接；Claude 可在内置结果缺角色时补齐，也可在已安装时有界取样以仲裁同角色冲突，其他 Provider 仍只把它作为内置主路径失败后的可选兜底。桥接必须固定规范化绝对路径、参数、工作目录、超时、输出字节和窗口数量，并按 Provider 白名单来源。账户身份、外部错误、pace、原始响应与凭据一律丢弃。内置 PTY/loopback 同样固定路径、端点、超时与上限，不经 shell，不解析 Antigravity TUI；本地证书放宽不得离开 127.0.0.1 专用 client。
- 本地路径、子进程、行长、消息数、总字节、扫描深度和执行时间必须有界；日志只允许 providerId、状态、reason code 与不可关联请求 ID。
- secret 只保存在系统安全存储或受控后端。跨机器若同步额度，只同步经验证的 envelope，不同步 secret、原始来源或本地路径。
- 公司 OpenAPI 配置的地址不是 secret，但仍属于本机连接元数据，不进入 envelope 或云端投影。请求只允许 HTTPS（本机 loopback 调试除外），固定 Bearer header、禁止 URL 凭据/query key/redirect，并限制连接时间、总时间和响应大小；429 按有界 `Retry-After` 或持久指数退避抑制重复请求。
- 上游失败仅影响额度区域；统计看板继续可用。合格 LKG 按 Provider 保存期限恢复并显式 stale，过期/越界/身份不匹配时 fail closed。

### 6.1 跨设备快照同步

跨设备同步是 Provider 授权之外的第二个独立 opt-in，默认关闭。没有本地 Provider 授权的桌面也可以作为只读设备启用同步。Android 与桌面云端读路径都不读取其他设备的 OAuth、Cookie、session、transcript、status-line 输入或本地路径，只消费通过 envelope v1 严格校验的脱敏投影。关闭同步、退出账户或撤销某个本地 Provider 授权只停止该设备的读写，不得隐式删除云端历史；删除必须由用户通过单 Provider 或全局删除动作明确触发。

云端 transport v2 固定使用四个 owner-scoped RPC，不把额度混入 Stats v2。PostgREST request key 与函数参数完全一致：

- `get_quota_snapshots_v2()`：返回 `{ "status": "ok", "transportVersion": 2, "epoch": 7, "revision": 12, "generatedAt": "RFC3339", "providers": [...], "providerStates": [...] }`。`providers` 只含当前有效 envelope；`providerStates` 为每个 `providerId + scope` 返回 `generation/deleted/sourceObservedAt/receivedAt`，包括墓碑。响应不含 user id、secret 或内部行标识；空 providers 表示“尚无有效同步值”，不是零额度。
- `upsert_quota_snapshots_v2(p_transport_version integer, p_epoch bigint, p_providers jsonb)`：`p_providers` 是 `{ "generation": 3, "envelope": {...} }` 数组。每个条目独立条件 upsert；请求未出现的 Provider 保持不变。只接受带非空窗口的 `ok/stale` envelope，`auth-required/error/unsupported` 不能覆盖 last-known-good。响应返回完整 `providers/providerStates` 以及 `upsertedProviderCount/ignoredProviderCount`。
- `delete_quota_snapshot_provider_v2(p_transport_version integer, p_epoch bigint, p_provider_id text, p_scope text, p_generation bigint)`：显式删除一个 Provider，写入墓碑并将该 Provider generation 加一；旧 generation 的在途写入只能被忽略。
- `clear_quota_snapshots_v2(p_transport_version integer, p_epoch bigint)`：显式全局删除，把现有 Provider 全部转为墓碑、各 generation 加一，并同时提升全局 epoch/revision；旧 epoch 的在途写入必须失败。

所有成功响应的整数使用非负 JSON integer；当前实现在达到 JavaScript safe-integer 上限前必须升级 transport version。失败使用 PostgREST 标准错误体 `{ "code": "22023", "message": "quota_snapshot_<reason>", "details": null, "hint": null }`，reason 为 `unsupported_transport | invalid_epoch | stale_epoch | invalid_provider_generation | stale_provider_generation | invalid_payload | payload_too_large | capacity_exceeded` 之一；身份失败沿用 `42501`，不回显输入内容。

**transport v3（门控货币单位，ADR-018，T10.284 实现，迁移 `20261004140000_quota_currency_transport_v3.sql`）**：新增 `get_quota_snapshots_v3()` 与 `upsert_quota_snapshots_v3(p_transport_version integer, p_epoch bigint, p_providers jsonb)`，语义与 v2 完全相同，只是校验额外接受 §2.2 的 `unit='currency'` 与 `currency` 字段，响应 `transportVersion` 为 `3`。删除与全局清除继续使用 v2 函数（v3 不另设），它们与墓碑、epoch、generation 共用同一批行。兼容规则：

- v2 `get` 改为服务端投影：凡 envelope 含任一 `currency` 窗口，在 `providers` 中省略该 envelope，并同时省略它的有效 `providerStates` 条目（已发布的 v2 读取方要求有效状态数等于 envelope 数，保留会让整条快照失败）；墓碑照常返回。旧桌面与旧 Android 因此永远收不到新单位，表现为「该来源未同步」。v2 `upsert` 维持旧校验，继续拒绝 `currency`；v1 读写同样不放行。v2 删除仍可删除货币 Provider，返回的 v2 投影同样省略货币条目。
- v3 读取方因 §2.2 第 5 条可能丢弃 envelope 或窗口，因此放宽状态核对：有效状态数可多于 envelope 数，envelope 的最新观测时间可早于状态的 `sourceObservedAt`；v2 读取方保持严格相等。
- 新桌面先调 v3；返回函数不存在（PostgREST `PGRST202` 或 HTTP 404）时视为旧云端，回退 v2，并在上传前剔除含 `currency` 窗口的 envelope（单独剔除，不影响同批其他 Provider），本机仍正常显示余额。
- 新 Android 优先 v3、同样回退 v2；按 §2.2 第 5 条逐窗口忽略未知单位，不再让整条快照失败。
- 同步投影在 v3 中允许 `currency` 字段，其余剥离规则（action、accountLabel、未知字段）不变；余额只同步金额与币种。
- 供应商余额来源（`balance-*`，T10.288）的上传授权就是该来源在本机的开启状态：开启即随额度同步经 v3 上传，关闭或配置无法读取则不上传；每轮上传前重新读取开启状态，不另设第二层开关。旧云端回退 v2 时按上条剔除。余额来源的历史快照会带 `balance_unavailable`、`api_key_required`、`secure_storage_unavailable`，服务端白名单由迁移 `20261004150000_quota_balance_reason_codes.sql` 补登；**线上必须先执行该迁移**，否则这类快照会让整批上传被拒为 `invalid_payload`。

**显式清空恢复（T10.308，迁移 `20261010170540_quota_recovery_metadata_and_write_guards`）**：`get_quota_snapshot_clear_metadata_v2()` 仅返回 `{status:"ok",transportVersion:2,epoch,revision,generatedAt}`，不读取或输出 envelope、墓碑或身份字段。它使用同一 owner state 行锁，只供已确认的全局清空动作取得条件 epoch，不用于展示缓存、普通同步绑定或上传；首次可初始化 owner state，不能称为数据库绝对只读。客户端成功响应限 1 KiB、错误体限 8 KiB，字段、安全整数和时间严格校验，拒绝当前 owner 已知水位倒退。此恢复接口仅标准错误码 `PGRST202` 才回退旧严格 get，空白或任意 HTTP 404 不回退；普通 v3 的既有兼容规则不变。异常旧服务仍需部署恢复接口，不从坏响应抽取 epoch、不调用无条件 v1 clear。随后调用原 clear v2；并发 `stale_epoch` 不自动重读再删除。完整回执仍限 128 KiB，验证零活跃、完整墓碑和 epoch/revision 前进。

最后发送许可在协调器、真实会话门禁与本地状态锁的共同保护下取得：先持久写入本机停止意图、关闭设置并清除绑定和缓存，确认落盘后才授予不可撤销的发送许可。许可前会话或操作代次失效不发送；本机停止失败返回 `quota_sync_clear_dispatch_stop_incomplete`，不发送 clear。许可后的超时、坏回执或代次失效只能报告结果未确认，不声称物理网络已撤销。确定云端拒绝返回 `quota_sync_clear_rejected_device_stopped`，本机仍保持停止，不自动恢复旧绑定；未知结果或进程崩溃重启也不得自动重绑上传或重发 clear，恢复同步需用户显式开启。切号不修改新账户；全部成功仍要求合法云端回执和本机停止确认。确认界面提前说明先关闭本机及删除失败也保持关闭。

**观测时间与容量错误（T10.308）**：新增或覆盖的最大 `observedAt` 超过本次服务端时钟 5 分钟时整批 `invalid_payload`，等号允许，未来 `resetsAt` 合法。不得只裁剪状态时间却保留 envelope 未来时间；旧 generation、墓碑前旧观测和更旧冲突观测保留原顺序忽略。新增或复活会使同账户活跃数超过 8 时整批 `capacity_exceeded`（PostgREST `22023/quota_snapshot_capacity_exceeded`）；本机单批超过 8 仍是生产者计数错误。旧客户端不能识别新错误时安全显示一般失败，不收到成功回执。关闭本机来源不删除云端持久历史，不能说成释放云端名额。

四个常规 v2、恢复元数据函数与两个 v3 函数均使用调用者身份，禁止 service-role 绕过产品授权路径；表启用并强制 RLS，客户端不能直接写表。RPC 权限只授予 `authenticated`，显式撤销 `public/anon/service_role`。`SECURITY DEFINER` 函数固定空 `search_path` 并 schema-qualify 所有对象。

同步投影只允许机器契约中定义的 envelope/window 字段，并额外强制移除：

- envelope `action`：桌面设置目标、命令与本地路径不下发 Android；Android 不根据 reasonCode 猜动作。
- window `accountLabel`：v1 跨设备快照不传邮箱、组织名或计划标签，避免把可识别账户信息写入同步层。
- 所有未知字段：普通 v1 reader 可忽略未来可选字段，但 v1 持久同步层按安全边界 fail closed，避免把未审计内容变成跨设备持久数据。

服务端与生产者都必须校验：单次最多 8 个 envelope、每个最多 16 个 window；生产者对紧凑 JSON 序列化做 60 KiB（61,440 UTF-8 bytes）预检，服务端以 PostgreSQL `octet_length(p_providers::text) <= 65536` 作为权威 64 KiB 上限。字符串最多 512 UTF-8 bytes，`providerId/windowId` 最多 128 UTF-8 bytes。`windowMinutes/staleAfterSeconds` 必须是 `1..2147483647` 的有限整数。数组、稳定键、枚举、时间、数值、状态归并和 percent/Credits 不变量任一失败时拒绝整个请求，不做部分写入、截断或 clamp。

容量中的 8 个上限针对当前有效 envelope 及非删除的活跃 providerStates；删除墓碑不占活跃来源名额，不能因状态总数超过 8 个拒绝合法快照。providerStates 仍须逐项校验稳定键、generation、删除形状与时间，并受读取端 128 KiB 传输响应预算约束；Rust远端缓存总文件仍限128 KiB，Android解密后缓存外层允许固定8 KiB元数据开销（总计136 KiB），其内嵌传输快照仍限128 KiB；不得截断或丢弃墓碑来凑容量。新增客户端接受此范围内的历史删除状态；旧客户端若因总状态计数拒绝，应升级客户端，服务端不通过丢弃墓碑破坏迟到写保护。上传仍整批遵守 8 个 envelope 与现有字节预算，超限返回可操作说明，不静默选择前 8 个。 服务端新增与墓碑复活都须在同一用户锁内检查活跃容量；不清理历史异常来源。若旧服务端曾产生超过8个活跃来源，仍拒绝把异常快照当合法读数，但允许用户主动清空：清空回执须无活跃来源，clearedProviderCount不得超过保留墓碑总数，且epoch/revision必须前进。

云端行不设年龄 TTL，并一直保留到账号删除或用户显式删除。客户端也不得仅因缓存年龄清除合格 LKG；即使最后一次同步非常久远，也要保留真实 `observedAt/fetchedAt/generatedAt` 并按每个 window 的 `observedAt + staleAfterSeconds` 与 `resetsAt` 显示 stale。RPC `generatedAt` 和本机缓存 `savedAt` 都不能刷新来源观测时间。身份不匹配、结构无效、全局 epoch 倒退或显式墓碑命中时仍须 fail closed，不能显示 0%。

旧 `get_quota_snapshots_v1()` 在升级后读取同一批持久有效行；旧 `replace_quota_snapshots_v1()` 降级为只对 `ok/stale` 做 additive latest-wins，不再删除遗漏 Provider，也不能跨越 v2 墓碑；旧 `clear_quota_snapshots_v1()` 仍被视为用户主动的全局删除，并通过 epoch 阻止迟到写。`expires_at` 与旧 purge cron 被停用，`private.purge_expired_quota_snapshots_v1()` 仅兼容返回 0。

**本机专用原因码上传（T10.318，2026-10-17；2026-10-22 精确匹配加固）**：§4 已登记的 14 个本机失败码（Claude native 6、Antigravity native 5、Antigravity CodexBar 3）可随 LKG `stale` 快照出现，但它们不在云端 wire 枚举里（服务端 `quota_snapshot_reason_valid_v1` 未登记，已发布的读取方遇到未知码会让整条读取失败）。因此本机投影上传前仅将这 14 个精确码换成 `source_temporarily_unavailable`（`src-tauri/src/quota_sync.rs` `cloud_reason_code`），本机显示仍用原码；未登记的同前缀码不得被泛化映射，必须继续被 envelope/window 投影校验拒绝。要让这些码上云，须按 §7 门控枚举例外走新 transport 版本。

### 6.2 传输身份与竞态

云端为每个用户保存单调 `epoch/revision`，并为每个 `providerId + scope` 保存单调 generation。四个 RPC 都先锁定用户 state 行，再锁定目标 Provider 行。普通同步的主冲突时钟是 envelope 所有窗口中最大的 `observedAt`：较新者覆盖，较旧者忽略；相同 `observedAt` 时后到服务器的请求以 `receivedAt` 决胜。上传集合缺项不表达删除。Provider 墓碑拦截较旧 generation，且同 generation 中 `observedAt <= tombstone.receivedAt` 的已确认旧观测也不能复活；只有墓碑之后真正产生的新观测才可重新发布。全局删除提升 epoch，旧 epoch 一律拒绝。

每轮桌面同步先 get 当前 epoch/generation，再读取纯本机 Provider，并且只上传本机授权产生的可用观测；下载缓存与展示合并结果不得回流到上传生产者。一般 Provider 展示按 `providerId + scope` 合并：本机与云端都可用时选最大 `observedAt`，平手优先本机；本机缺失或报错而云端有 LKG 时显示云端值。Claude 例外按规范 5h/7d 角色应用第 3 节的来源仲裁，附加窗口按稳定语义键去重；这允许云端正确周窗口补齐本机单窗口或压过低置信度 native 100%，并保留获胜窗口的来源与观测时间。收到竞态 `stale_epoch` 后保持 opt-in，下一次 get 可重新绑定，不把云端变化误判成需要再次授权。

v2 上传仍是 Provider 原子更新，不能上传展示合并结果。若纯本机 Claude envelope 缺少云端已有规范角色，或任一同角色输给云端更高置信度观测，则本轮省略该 Provider，而不是上传部分窗口或错误 native 100%；请求缺项不表示删除，因此云端 LKG 保持不变。之后纯本机获得同等或更高置信度的完整观测时恢复上传。这个保护只影响 Claude Provider 的上传资格，不改变 epoch/generation/latest-wins 协议，也不把云端数据伪装为本机观测。

读取、桌面 owner-bound 缓存、Android 加密缓存和 latest-wins 身份至少绑定 `authenticated user + transportVersion + epoch + revision`；Android 额外使用进程 writer/session generation 防迟到写。切换 Supabase 用户或退出登录会清除该设备内存/持久缓存，但不会清除服务器行；迟到响应不得写回。Provider/window 顺序不承载语义，消费者继续使用 `providerId + scope` 与 `providerId + scope + windowId` 稳定键。

展示层若受版面限制，必须先按稳定键去重并用机器字段确定性选择，不能把数组位置解释为“主窗口”。周期角色优先来自 `windowMinutes`，同角色多个百分比窗口按已用比例降序、再按 `windowId` 排序；完整列表不做该裁剪。某个产品表面另有 Provider 角色偏好时，该偏好属于展示设计而非 wire 字段，不得回写 envelope。替代偏好角色或隐藏剩余窗口必须以文字说明，不能只靠颜色。该规则不新增 v1 字段，旧生产者与旧缓存继续兼容。

## 7. 版本与兼容

- v1 Producer 固定输出 `schemaVersion=1`。同一版本只允许增加语义独立的可选字段；删除/改名必填字段、改变单位/时间/状态语义、增加无法安全忽略的枚举值或改变稳定键，必须提升 schemaVersion。
- **门控枚举例外**：新增枚举值若能保证任何旧读取方都收不到，可以不提升 schemaVersion。保证手段必须同时满足：本机 IPC 只在同一版本的 Rust 与 React 之间传递；云端由新 transport 版本承载，旧 transport 的读接口在服务端投影中省略含新值的 envelope、写接口继续拒绝；本机 LKG 在降级后遇到新值时按既有规则 fail closed 并给出 reason code。目前唯一的门控枚举值是 `unit='currency'`（2026-10-04，§2.2、§6.1）。
- Rust、TypeScript、云端 DTO 与 Kotlin 必须共同演进并消费同一组匿名 fixture。跨 IPC/云端的 v1 reader 忽略未知可选字段；安全敏感的持久 LKG 可以对未知字段 fail closed，但必须保留可诊断 reason code。
- 旧桌面、旧云端或 Android 响应没有 quota 字段时表示“该能力不可用/未同步”，不是零额度。客户端不得从 Stats、费用或活动量推导 quota。
- schema 升级必须保留上一版本 fixture、定义 downgrade 行为，并在 TASKS 中登记唯一契约写入者；不得由单端先行发布新必填字段。

## 8. 契约验收

至少使用匿名 fixture 覆盖：单窗口、多窗口、窗口独立缺失、LKG stale、auth-required、unsupported 空窗口、上游 error、百分比越界、Credits 余额、unlimited、公司 OpenAPI 多窗口与 secret-free 投影、旧响应缺 quota、未知可选字段与撤权竞态。Rust、TypeScript、Kotlin 对同一 fixture 的稳定键、状态、时间和可绘制进度判断必须一致。

共享 fixture 固定在 `fixtures/quota-provider-v1/`：

| 文件 | 作用 |
|---|---|
| `complete-v1.json` | Codex 多窗口、Credits 余额、Claude stale、Antigravity 四窗口、手工预算与 unlimited 的合法 envelope |
| `states-v1.json` | auth-required、unsupported、error、旧响应缺 quota 与未知可选字段兼容 |
| `invalid-v1.json` | 百分比/算术/时间/整数上限/稳定键/状态/action 与同步投影的 fail-closed 矩阵 |
| `transport-v1.json` | 已发布 v1 wire、完整替换与 24h/25h TTL 的历史兼容基线 |
| `transport-v2.json` | 持久 latest-wins wire、provider generation/墓碑、缺项保留、来源时间冲突与旧数据读取语义 |
| `custom-openapi-v1.json` | 公司 OpenAPI 已验证金额换算的稳定 Provider ID、`api-organization/official-api`、`plan-dependent` 与三类匿名合成百分比窗口；明确不含 key、URL、人民币金额或原始响应，并可进入既有 LKG/owner-bound v2 |
| `currency-v1.json` | `currency` 余额单窗口与多币种、只有 remaining、带同币种上限、缺 `currency`、小写或非三字母币种、`currency` 出现在非货币单位、未知 unit 逐窗口丢弃（T10.284） |
| `transport-v3.json` | v3 读写含 `currency`；v2 读省略含 `currency` 的 envelope 及其有效 providerStates；v2 写拒绝 `currency`；新客户端遇旧云端回退 v2 并剔除货币 envelope（T10.284） |
| `balance-v1.json` | 四家供应商官方余额响应样例与应得金额、中转余额、`balance_unavailable` 与 `api_key_required` 状态，以及每个窗口的统一金额文本 `display`（§2.2 第 5 条）；桌面同步用它覆盖余额来源随开启授权经 v3 上传、旧云端回退 v2 时剔除，云端回归用它覆盖余额原因码（T10.285、T10.288） |
| `experimental-plans-v1.json` | 三家实验套餐（ADR-018 U-109）的匿名上游样例、应得窗口与必须 fail closed 的情形，以及生产者 envelope 与读取方应显示的窗口文本 |
| `transport-capacity-v1.json` | 8 个活跃 envelope/state 上限、墓碑保留且不占名额、128KiB 字节预算的容量回归（T10.307b，迁移 `20261007045426_quota_active_capacity`） |

跨设备实现必须直接消费这些文件，不得把同形状对象复制进 Kotlin/Rust/TypeScript 测试。普通 envelope reader 对未知可选字段保持前向兼容；安全持久同步层使用 `invalid-v1.json` 中的 `sync-*` 用例拒绝未知字段、action 和 accountLabel。fixture 中的时间、账户和额度均为匿名合成数据。

fixture、mock、Preview 或开发截图只能标为 `fixture`；真实 Codex/Claude 账户、真实组织 API、macOS/Windows 子进程权限和 Android 呈现必须单独标为 `real-platform`。没有真实凭据/平台证据时不得把契约测试写成端到端完成。
