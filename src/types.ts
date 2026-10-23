// Shared TypeScript types extracted from App.tsx so that future component
// splits (T3) and the upcoming visual redesign can import the dashboard
// data contract from one place. The shapes match exactly what the
// Supabase RPC get_dashboard_stats(p_user, p_range, p_machine, p_timezone)
// returns and what the local get_stats() command returns in Rust. They are
// also what the local cache (local_stats_cache table) stores as JSON.

export interface Summary {
  /** Effective tokens (input + output). Cache volume is reported separately. */
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  /** Cache read + write combined. */
  cachedTokens: number;
  /** Read/write split and savings — absent on clouds running the pre-v2 RPC. */
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /**
   * Gross cache-read savings only (the write premium is not deducted). Kept for
   * older readers; new UI reads `cacheSavings` (contract dashboard-stats-v2 §2.4).
   */
  cacheSavedUsd?: number;
  /**
   * Net cache savings (T10.162/T10.183). Present only together with a proven
   * read/write split; absent means unavailable for this range, never zero.
   */
  cacheSavings?: CacheSavings;
  totalCost: number;
  totalRequests: number;
  avgTokensPerReq: number;
}

/** Where the unit prices behind `cacheSavings` come from (contract §2.4). */
export type CacheSavingsPriceBasis = 'local-prices' | 'uploaded-prices';

/** `summary.cacheSavings` — contract dashboard-stats-v2 §2.4. Amounts in USD. */
export interface CacheSavings {
  /** Read volume × max(input − cache-read price, 0); equals the gross `cacheSavedUsd`. */
  readSavedUsd: number;
  /** Write volume × max(cache-write price − input, 0); never negative. */
  writePremiumUsd: number;
  /** `readSavedUsd − writePremiumUsd`; may be negative (writes cost more than reads saved). */
  netSavedUsd: number;
  /** Read tokens priced from a fallback rather than a listed price. */
  fallbackPricedReadTokens: number;
  /** Write tokens priced from a fallback (a missing write price is input × 1.25). */
  fallbackPricedWriteTokens: number;
  priceBasis: CacheSavingsPriceBasis;
}

export interface ToolStat {
  name: string;
  input: number;
  output: number;
  cached: number;
  /** Read/write split — absent on clouds running the pre-v2 RPC. */
  cacheRead?: number;
  cacheWrite?: number;
  total: number;
  cost: number;
  requests: number;
  models?: Record<string, number>;
  heatmap?: Record<string, number>;
}

/**
 * Effective tokens (input + output) computed client-side, so the headline
 * metric is correct on both the local backend and clouds that still run the
 * pre-v2 RPC (whose `total` fields include cache volume).
 */
export function effectiveTokens(stat: { input: number; output: number }): number {
  return (stat.input || 0) + (stat.output || 0);
}

export function summaryEffectiveTokens(summary: Summary): number {
  return (summary.inputTokens || 0) + (summary.outputTokens || 0);
}

/**
 * Tools whose token figures are heuristics (character counts or coarse log
 * fields), or hybrid (AntGravity legacy App transcripts are estimated while
 * CLI PLANNER_RESPONSE transcripts report real token counters).
 */
export const ESTIMATED_TOOLS: ReadonlySet<string> = new Set(['antigravity', 'trae']);

/**
 * Whether an individual detail log row should be marked as estimated (`~`).
 * Explicit provenance takes priority, including reported rows with zero cache.
 * Older responses without provenance retain the legacy display fallback.
 */
export function isEstimatedLogItem(
  item: Pick<LogHistoryItem, 'tool' | 'cachedTokens' | 'cacheReadTokens' | 'usageProvenance' | 'source'>,
): boolean {
  if (item.usageProvenance === 'reported') return false;
  if (item.usageProvenance === 'estimated') return true;
  if (item.source === 'gateway') return false;
  const toolKey = item.tool.toLowerCase();
  if (!ESTIMATED_TOOLS.has(toolKey)) return false;
  if (
    toolKey === 'antigravity' &&
    ((item.cachedTokens || 0) > 0 || (item.cacheReadTokens || 0) > 0)
  ) {
    return false;
  }
  return true;
}

export interface ModelStat {
  name: string;
  total: number;
  requests: number;
  input?: number;
  output?: number;
  cached?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: number;
  tool?: string;
  heatmap?: Record<string, number>;
  displayTotal?: number;
}

export interface TrendPoint {
  date: string;
  [tool: string]: string | number;
}

export interface LogHistoryItem {
  id: number;
  tool: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheWriteTokens?: number;
  cost: number;
  timestamp: string;
  sessionId: string;
  machineId: string;
  cacheReadTokens?: number;
  /** Optional local provenance; absent on older/cloud responses. */
  usageProvenance?: 'reported' | 'estimated';
  granularity?: 'request' | 'hour';
  requests?: number;
  /** Local detail rows only (contract §2.5); absent means scanned. Unknown values stay displayable. */
  source?: 'scan' | 'gateway' | 'imported-magpie' | (string & {});
  /** Gateway provider id; present only on gateway rows. */
  provider?: string;
}

export interface FacetOption {
  value: string;
  count: number;
}

export interface StatsQueryContext {
  range: RangeKey;
  timezone: string;
  machines: string[];
  tools: string[];
  models: string[];
  search: string | null;
  tokenMode: 'effective';
  /** 仅 `range = 'custom'` 时存在的本地日期闭区间（YYYY-MM-DD，含两端）。 */
  start?: string;
  end?: string;
  /** Additive response aliases for pre-multi-filter v2 readers. */
  machine?: string | null;
  tool?: string | null;
  model?: string | null;
}

export interface UsageDetailsQuery extends StatsQueryContext {
  scope: DataScope;
  cursor?: string | null;
  limit?: number;
}

export interface EntitySelector {
  kind: 'tool' | 'model';
  id: string;
}

export interface EntityDashboardQuery extends StatsQueryContext {
  scope: DataScope;
  entity: EntitySelector;
}

export interface UsageDetailsResponse {
  status?: 'ok';
  items: LogHistoryItem[];
  nextCursor?: string | null;
  hasMore: boolean;
  totalCount: number;
  filteredSummary: Summary;
  availableFilters: {
    tools: FacetOption[];
    models: FacetOption[];
    machines: FacetOption[];
  };
  granularity: 'request' | 'hour';
  meta?: {
    contractVersion?: number;
    generatedAt?: string;
    timezone?: string;
    query?: StatsQueryContext;
    entity?: EntitySelector;
    capabilities?: { gatewayLedger?: boolean };
  };
}

/** Honest legacy-cloud shape: v2-only fields are null, never fake success values. */
export interface UsageDetailsUnavailable {
  status: 'unavailable';
  reasonCode?: string;
  unavailable: { code: string; message: string };
  items: [];
  nextCursor: null;
  hasMore: null;
  totalCount: null;
  filteredSummary: null;
  availableFilters: null;
  granularity: null;
  meta?: {
    contractVersion?: number;
    generatedAt?: string;
    timezone?: string;
    query?: StatsQueryContext;
    entity?: EntitySelector;
  };
}

export type UsageDetailsEnvelope = UsageDetailsResponse | UsageDetailsUnavailable;

export interface ComparisonSeriesPoint {
  bucket: string;
  tokens: number;
  requests: number;
  cost: number;
}

export interface ComparisonDeltaMetric {
  absolute: number;
  percent: number | null;
  direction: 'up' | 'down' | 'flat' | 'new';
}

export interface UsageComparison {
  window: {
    kind: 'dayOverDay' | 'weekOverWeek' | 'monthOverMonth' | 'periodOverPeriod';
    timezone: string;
    bucket: 'hour' | 'day';
    currentStart: string;
    currentEnd: string;
    previousStart: string;
    previousEnd: string;
    alignedThrough: string;
  };
  current: { summary: Summary; series: ComparisonSeriesPoint[] };
  previous: { summary: Summary; series: ComparisonSeriesPoint[] };
  delta: {
    tokens: ComparisonDeltaMetric;
    requests: ComparisonDeltaMetric;
    cost: ComparisonDeltaMetric;
  };
}

export interface CompositionItem {
  value: string;
  tokens: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  cacheWriteTokens?: number;
  requests: number;
  cost: number;
}

export interface EntityDashboard {
  status?: 'ok';
  entity: {
    kind: 'tool' | 'model';
    tool?: string | null;
    model?: string | null;
  };
  summary: Summary;
  comparison?: UsageComparison | null;
  composition: {
    tools: CompositionItem[];
    models: CompositionItem[];
    machines: CompositionItem[];
  };
  heatmap: Record<string, number>;
  peak?: {
    bucket?: string;
    tokens?: number;
    requests?: number;
    cost?: number;
  };
  activity?: {
    activeDays?: number;
    firstSeenAt?: string | null;
    lastSeenAt?: string | null;
  };
  historyPage: UsageDetailsResponse;
  granularity: 'request' | 'hour';
  meta?: {
    contractVersion?: number;
    generatedAt?: string;
    timezone?: string;
    query?: StatsQueryContext;
    entity?: EntitySelector;
  };
}

export interface EntityDashboardUnavailable {
  status: 'unavailable';
  reasonCode?: string;
  unavailable: { code: string; message: string };
  entity: {
    kind: 'tool' | 'model';
    tool?: string | null;
    model?: string | null;
  };
  summary: null;
  comparison: null;
  composition: null;
  heatmap: null;
  peak: null;
  activity: null;
  historyPage: UsageDetailsUnavailable;
  granularity: null;
  meta?: {
    contractVersion?: number;
    generatedAt?: string;
    timezone?: string;
    query?: StatsQueryContext;
    entity?: EntitySelector;
  };
}

export type EntityDashboardEnvelope = EntityDashboard | EntityDashboardUnavailable;

export interface QuotaAction {
  kind: 'open-url' | 'open-settings' | 'show-command';
  labelKey: string;
  value: string;
}

export interface QuotaWindowSnapshot {
  providerId: string;
  windowId: string;
  windowLabel: string;
  accountLabel?: string;
  scope: 'consumer-subscription' | 'api-organization' | 'manual-budget';
  source: 'official-api' | 'local-authorized' | 'manual';
  status: 'ok' | 'stale' | 'auth-required' | 'error';
  used?: number;
  limit?: number;
  remaining?: number;
  unit: 'percent' | 'requests' | 'tokens' | 'usd' | 'credits' | 'currency';
  /** ISO 4217 alphabetic code; present exactly when `unit === 'currency'`. */
  currency?: string;
  windowMinutes?: number;
  resetsAt?: string;
  observedAt: string;
  fetchedAt: string;
  staleAfterSeconds: number;
  reasonCode?: string;
}

export interface QuotaProviderEnvelope {
  schemaVersion: number;
  providerId: string;
  displayName: string;
  scope: 'consumer-subscription' | 'api-organization' | 'manual-budget';
  mode: 'automatic' | 'manual' | 'unsupported';
  capability: 'stable' | 'plan-dependent' | 'experimental' | 'manual' | 'unsupported';
  status: 'ok' | 'stale' | 'unsupported' | 'auth-required' | 'error';
  windows: QuotaWindowSnapshot[];
  reasonCode?: string;
  action?: QuotaAction;
}

export type DailyCostUnavailableReason = 'incomplete-coverage' | 'missing-cost' | 'invalid-cost' | 'legacy-zero';

export type DailyCost =
  | { date: string; amountUsd: number; status: 'recorded-estimate'; reason?: never }
  | { date: string; amountUsd: null; status: 'unavailable'; reason: DailyCostUnavailableReason };

export interface DailyCosts {
  coverage: { start: string | null; end: string; timezone: string; state: 'complete' | 'partial' };
  days: DailyCost[];
}

export interface StatsData {
  summary: Summary;
  tools: Record<string, ToolStat>;
  models: Record<string, ModelStat>;
  trends: TrendPoint[];
  heatmap: Record<string, number>;
  history: LogHistoryItem[];
  /** Query-bound recorded estimates; absent means this capability is unavailable. */
  dailyCosts?: DailyCosts;
  /** Query-bound device aggregate; absent on clouds that predate T6.3. */
  machineDistribution?: CompositionItem[];
  historyPage?: UsageDetailsResponse;
  comparison?: UsageComparison | null;
  machines?: string[];
  meta?: {
    contractVersion?: number;
    generatedAt?: string;
    lastRefreshedAt?: string | null;
    timezone?: string;
    range?: RangeKey;
    machine?: string | null;
    stale?: boolean;
    query?: StatsQueryContext;
    capabilities?: {
      comparison?: boolean;
      detailPagination?: boolean;
      entityDashboard?: boolean;
      multiFilterSearch?: boolean;
      quotaSnapshots?: boolean;
      /**
       * The producer computes `summary.cacheSavings` (contract §2.4). When true,
       * a missing object means "unavailable for this range"; when absent, the
       * source predates net cache savings.
       */
      cacheSavings?: boolean;
      /** Local producer merged gateway records per contract §2.5. */
      gatewayLedger?: boolean;
    };
  };
}

export interface CloudConfig {
  supabase_url: string;
  supabase_key: string;
}

export interface CloudStatus {
  configured: boolean;
  authenticated: boolean;
  email: string;
  userId: string;
}

export type QuotaSyncState =
  | 'disabled'
  | 'active'
  | 'syncing'
  | 'paused'
  | 'auth-required'
  | 'unavailable'
  | 'error';

export interface QuotaSyncStatus {
  enabled: boolean;
  state: QuotaSyncState;
  lastSyncedAt?: string;
  reasonCode?: string;
}

export interface CustomQuotaEndpointConfig {
  id: string;
  displayName: string;
  url: string;
  enabled: boolean;
  /** Non-secret presence metadata; absent means legacy config not checked. */
  apiKeyConfigured?: boolean | null;
}

export interface CustomQuotaEndpointView extends CustomQuotaEndpointConfig {
  providerId: string;
  hasApiKey: boolean | null;
  schemaVerified: boolean;
}

/** `detect_quota_sources` 的一项：只说明本机是否装了该来源，不含任何凭据或登录信息。 */
export interface QuotaSourceDetection {
  providerId: string;
  installed: boolean;
  candidatePaths: string[];
}

/** 余额来源的供应商类别：四家官方余额接口，其余「供应商」页条目按中转站处理（REQ-QUOTA-10）。 */
export type QuotaBalanceVendor = 'moonshot' | 'deepseek' | 'openrouter' | 'siliconflow' | 'relay';

/** 中转余额的显式配置：地址须与该中转站接口地址同源，币种由用户声明。 */
export interface QuotaRelayBalanceConfig {
  balanceUrl: string;
  valuePath: string;
  currency: string;
}

/** `list_quota_balance_sources` 的一项：只含元数据，key 留在钥匙串的 `provider:<id>` 条目里。 */
export interface QuotaBalanceSourceView {
  gatewayProviderId: string;
  gatewayProviderName: string;
  host: string;
  vendor: QuotaBalanceVendor;
  providerId: string;
  enabled: boolean;
  relay: QuotaRelayBalanceConfig | null;
}

/** 实验性套餐用量来源（REQ-QUOTA-11）：接口无公开文档，默认关闭，开启前须确认当前风险版本。 */
export type QuotaExperimentalPlanVendor = 'zhipu-glm' | 'minimax' | 'kimi-code';

/** `list_quota_experimental_plans` 的一项：只含元数据；key 留在「供应商」页对应条目的钥匙串里。 */
export interface QuotaExperimentalPlanView {
  providerId: 'zhipu-glm-plan' | 'minimax-plan' | 'kimi-code-plan';
  vendor: QuotaExperimentalPlanVendor;
  displayName: string;
  enabled: boolean;
  /** 已确认的风险版本等于当前 `riskVersion`；版本提升后变回 false，需要重新确认。 */
  consentCurrent: boolean;
  riskVersion: number;
  /** 「供应商」页里落在该家固定域名上的供应商；没有时不能开启。 */
  gatewayProviderName: string | null;
  host: string | null;
}

/**
 * 订阅设置（T10.188，契约 docs/contracts/cost-profile-local-v1.md）。服务商、币种、
 * 计费周期与付费方式都是闭合集合；解析见 `src/utils/contracts/costProfile.ts`。
 */
export type CostProvider = 'anthropic' | 'openai' | 'google' | 'moonshot' | 'zhipu' | 'minimax' | 'deepseek' | 'other';
export type CostCurrency = 'USD' | 'CNY';
export type CostBillingCycle = 'monthly' | 'yearly';
/** 按量付费。不在 `toolBillingModes` 里的工具即「未设置」，不默认视为按量。 */
export type CostBillingMode = 'payg';

export interface CostSubscriptionPlan {
  /** 本机生成的稳定 ID：`sub-` 加 16 位小写十六进制。 */
  id: string;
  name: string;
  provider: CostProvider;
  /** 每个计费周期的订阅费：大于 0，不超过 100,000，最多两位小数。 */
  fee: number;
  currency: CostCurrency;
  cycle: CostBillingCycle;
  /** 月付计费日 1–31，大于当月天数时按月末；年付忽略，按开始日期的月日计费。 */
  anchorDay: number;
  /** 本地日期 `YYYY-MM-DD`，含。 */
  startDate: string;
  /** 本地日期 `YYYY-MM-DD`，含；null 表示仍在订阅。 */
  endDate: string | null;
  tools: string[];
  /** 空表示这些工具的全部模型；按 ASCII 不区分大小写的前缀匹配。 */
  modelPrefixes: string[];
  /** 空表示全部设备。 */
  machines: string[];
}

/** `get_cost_profile` 的返回；保存成功时同形返回保存后的状态。 */
export interface CostProfile {
  revision: number;
  plans: CostSubscriptionPlan[];
  toolBillingModes: Record<string, CostBillingMode>;
  /** 1 美元 = x 元；null 表示设置文件里的汇率无法识别，人民币换算不可得，直到保存有效汇率。 */
  cnyPerUsd: number | null;
}

/** 提交给 `validate_cost_profile` / `save_cost_profile` 的订阅；新订阅的 id 为 null。 */
export interface CostSubscriptionPlanInput extends Omit<CostSubscriptionPlan, 'id'> {
  id: string | null;
}

/**
 * 整份提交，不含 revision（另作 `expectedRevision` 传）。「删除全部订阅设置」用
 * `clear_cost_profile`；提交 null 会得到 `profile` 的 required 错误，不会清空。
 */
export interface CostProfileInput {
  plans: CostSubscriptionPlanInput[];
  toolBillingModes: Record<string, CostBillingMode>;
  /** 汇率不可得时原样提交 null，得到 cnyPerUsd 的 required 错误，由用户填写；不代填默认值。 */
  cnyPerUsd: number | null;
}

export type CostProfileErrorCode =
  | 'required'
  | 'invalid'
  | 'too_long'
  | 'too_many'
  | 'duplicate'
  | 'out_of_range'
  | 'precision'
  | 'in_future'
  | 'before_start'
  | 'overlap';

export type CostProfileErrorField =
  | 'profile'
  | 'plans'
  | 'toolBillingModes'
  | 'cnyPerUsd'
  | 'plan'
  | 'id'
  | 'name'
  | 'provider'
  | 'fee'
  | 'currency'
  | 'cycle'
  | 'anchorDay'
  | 'startDate'
  | 'endDate'
  | 'tools'
  | 'modelPrefixes'
  | 'machines';

/** 设置页可以就近显示的字段级错误。 */
export interface CostProfileFieldError {
  /** 所属订阅在提交数组里的下标；汇率、付费方式等整份设置的字段为 null。 */
  planIndex: number | null;
  field: CostProfileErrorField;
  /** tools / modelPrefixes / machines 中出错那一项的下标。 */
  itemIndex: number | null;
  /** toolBillingModes 中出错的工具，或无法识别的字段名。 */
  key: string | null;
  /** 重名、ID 重复或时段重叠时，与之冲突的较早那个订阅的下标。 */
  relatedPlanIndex: number | null;
  code: CostProfileErrorCode;
  /** 可直接显示的中文提示；可能含订阅名称，只用于界面，不得写日志。 */
  message: string;
}

export interface CostProfileValidation {
  valid: boolean;
  errors: CostProfileFieldError[];
}

/** `save_cost_profile` 的返回；`cleared` 表示保存后是规范空状态（C1 据此写云端墓碑）。 */
export type CostProfileSaveResult =
  | { status: 'saved'; profile: CostProfile; cleared: boolean }
  | { status: 'conflict'; currentRevision: number }
  | { status: 'invalid'; errors: CostProfileFieldError[] };

/** `clear_cost_profile`（删除全部订阅设置）的返回：成功后一定是规范空状态，没有校验错误。 */
export type CostProfileClearResult =
  | { status: 'saved'; profile: CostProfile; cleared: true }
  | { status: 'conflict'; currentRevision: number };

export interface AppSettings {
  scan_interval_secs: number;
  scan_policy_version: number;
  desktop_interval_secs: number;
  lockscreen_interval_secs: number;
  wallpaper_desktop_enabled: boolean;
  wallpaper_lockscreen_enabled: boolean;
  wallpaper_consent_version: number;
  autostart_enabled: boolean;
  start_minimized: boolean;
  widget_open_at_startup: boolean;
  tray_text_enabled: boolean;
  /** 指向托盘图标即临时显示挂件、移开后收起（T10.110）；关闭后只有单击切换。 */
  tray_hover_widget_enabled: boolean;
  /** 指针在托盘图标上停留多少毫秒才弹出托盘挂件；0 = 立即（容易被"路过"误触）。 */
  tray_hover_delay_ms: number;
  /** 桌面层长驻一块小组件（壁纸之上、其他窗口之下）；托盘菜单勾选项与之同源。 */
  desktop_widget_enabled: boolean;
  /** 桌面小组件上次被拖到的位置（物理像素），null = 工作区右下角。 */
  desktop_widget_position: [number, number] | null;
  /**
   * 两块挂件各自的内容配置（T10.124）。取值是闭合集合，解析与回落见
   * `src/utils/widgetConfig.ts`；Rust 侧 `settings.rs` 用同一组字符串。
   * provider 为 null 表示自动挑最吃紧的一条窗口。
   */
  widget_popover_layout: string;
  widget_popover_theme: string;
  widget_popover_range: string;
  widget_popover_provider: string | null;
  widget_desktop_layout: string;
  widget_desktop_theme: string;
  widget_desktop_range: string;
  widget_desktop_provider: string | null;
  wallpaper_use_cloud: boolean;
  wallpaper_device_filter: string;
  wallpaper_dynamic_bg_enabled: boolean;
  quota_codex_local_enabled: boolean;
  /** 「读取 Claude 额度」总开关（U-107）；下面两个旧字段由后端按它派生。 */
  quota_claude_enabled: boolean;
  quota_claude_statusline_enabled: boolean;
  quota_claude_codexbar_enabled: boolean;
  quota_antigravity_local_enabled: boolean;
  quota_antigravity_codexbar_enabled: boolean;
  quota_custom_endpoints: CustomQuotaEndpointConfig[];
  quota_snapshot_sync_enabled: boolean;
  /**
   * 订阅设置的存储镜像（T10.188），只读（`readonly`）：读写一律经 `get_cost_profile` 与按
   * revision 条件的 `save_cost_profile`、`clear_cost_profile`，通用 `save_settings` 忽略这四个字段。
   */
  readonly cost_subscription_plans?: CostSubscriptionPlan[];
  readonly cost_tool_billing_modes?: Record<string, CostBillingMode>;
  readonly cost_cny_per_usd?: number | null;
  readonly cost_profile_revision?: number;
  /**
   * 模型接入总开关（U-112），只读：只经 `gateway_set_model_access` 写入，通用 `save_settings`
   * 忽略它。设置未读到前为 undefined（未知）。
   */
  readonly model_access_enabled?: boolean;
  readonly model_access_version?: number;
}

export interface DbInfo {
  path: string;
  totalRecords: number;
  unsyncedRecords: number;
  earliest: string | null;
  latest: string | null;
  sizeBytes: number;
  /** Free pages SQLite can return to the OS with a VACUUM; absent on older backends. */
  reclaimableBytes?: number;
}

export type RangeKey = 'today' | 'week' | 'month' | 'year' | 'all' | 'custom';

/** `range = 'custom'` 时的本地日期闭区间，两端都是 `YYYY-MM-DD`（T10.108）。 */
export interface CustomDateRange {
  start: string;
  end: string;
}
export type DataScope = 'local' | 'cloud';
export type StatsErrorAction = 'load' | 'scan';
/** Model access pages: Agent, providers, gateway and routing (U-92). */
export type ModelTab = 'agents' | 'providers' | 'gateway' | 'routing';
/**
 * Page surfaces. `dashboard`, `records` and `behavior` are the 概览 / 记录 / 行为分析 sub-views
 * of the single sidebar entry 「用量」 (U-89, U-100); the header still adapts per surface.
 */
export type Tab = 'dashboard' | 'records' | 'behavior' | 'logs' | 'settings' | ModelTab;
export const MODEL_TABS: readonly ModelTab[] = ['agents', 'providers', 'gateway', 'routing'];
export const isModelTab = (tab: Tab): tab is ModelTab => (MODEL_TABS as readonly Tab[]).includes(tab);

export function isUsageTab(tab: Tab): boolean {
  return tab === 'dashboard' || tab === 'records' || tab === 'behavior';
}

export interface BehaviorAnalysisQuery extends StatsQueryContext {}

/**
 * 行为契约 v1.2 的项目维度（T10.182）：本机索引状态，与 `get_project_dimension_status` 同词。
 * `disabled`（未开启）与 `consent_required`（授权版本过低）时响应不含任何项目字段。
 */
export type BehaviorProjectDimensionState = 'disabled' | 'consent_required' | 'indexing' | 'ready' | 'failed';

/** 命名项目或固定分组（主目录、磁盘根目录、临时目录、托管会话）。 */
export type BehaviorProjectKind = 'named' | 'home' | 'root' | 'temp' | 'managed';

/**
 * 项目引用。`key` 是不透明、稳定的标识：命名项目为 `n:` + 小写文件夹名，固定分组为
 * `@home` / `@root` / `@temp` / `@managed`；从不是路径或哈希，前端不得用名称拼键。
 * `label` 只有命名项目才有（清洗后的文件夹名），固定分组为 `null`，由前端显示本地化名称。
 */
export interface BehaviorProjectRef {
  key: string;
  label: string | null;
  kind: BehaviorProjectKind;
}

/**
 * 无法归到项目的原因：来源不记录工作目录、来源支持但无法确定、尚未建立索引、缺少会话 ID
 * （最后一类与 v1.1 `unknownSession*` 是同一批记录）。
 */
export type BehaviorUnattributedReason = 'unsupported_source' | 'unresolved' | 'pending' | 'missing_session';

/** 会话级未归属原因：会话总有 ID，所以没有 `missing_session`。 */
export type BehaviorSessionProjectReason = Exclude<BehaviorUnattributedReason, 'missing_session'>;

/** 回填失败的固定原因码；其它任何值都按未知（`null`）处理。 */
export type BehaviorProjectFailureCode = 'database_error' | 'internal_error';

/**
 * `meta.projectDimension`。整个字段缺失表示后端不支持项目维度，或本机项目索引读不出来，
 * 两者都按「后端不支持」处理，不得读作关闭或 0。
 * 采集中（`indexing`/`ready`/`failed`）时另有所选范围内（不计项目筛选）已有、尚无索引行的
 * 会话数与生效筛选的回显；`lastFailure` 只在 `failed` 时出现，是固定原因码或 `null`。
 */
export type BehaviorProjectDimensionMeta =
  | { state: 'disabled' | 'consent_required' }
  | {
    state: 'indexing' | 'ready' | 'failed';
    indexedSessions: number;
    pendingSessions: number;
    filter: string[];
    lastFailure?: BehaviorProjectFailureCode | null;
  };

/**
 * 项目排行的一行。`tokens` 是有效 Token（输入 + 输出），`requests` 是记录数；`cost` 是 D5①
 * 单条估价之和，任一记录不可得时为 `null`（不是 0）；`share` 的分母是 `summary.tokens`
 * （含未归属），分母为 0 时为 `null`。
 */
export interface BehaviorProject extends BehaviorProjectRef {
  tokens: number;
  requests: number;
  sessionCount: number;
  cost: number | null;
  share: number | null;
  /** 该项目的工具构成，按有效 Token 倒序；`id` 与顶层 `tools[].id` 同值。 */
  tools: Array<{ id: string; tokens: number }>;
}

/** 超出 `projectLimit` 的项目合计；费用口径与 `BehaviorProject` 相同。 */
export interface BehaviorProjectsRemainder {
  tokens: number;
  requests: number;
  sessionCount: number;
  cost: number | null;
  share: number | null;
  projectCount: number;
}

export interface BehaviorUnattributedReasonRow {
  reason: BehaviorUnattributedReason;
  tokens: number;
  requests: number;
  /** `missing_session` 的记录不是会话，会话数未知，恒为 `null`（不是 0）。 */
  sessionCount: number | null;
  share: number | null;
}

/** 未归属合计；`sessionCount` 与 `summary.sessionCount` 同口径，不含缺少会话 ID 的记录。为 0 的原因不列出。 */
export interface BehaviorUnattributed {
  tokens: number;
  requests: number;
  sessionCount: number;
  cost: number | null;
  share: number | null;
  reasons: BehaviorUnattributedReasonRow[];
}

/**
 * `get_local_behavior_analysis` 的调用参数。`projects` 是契约 v1.2 的可选项目筛选：取值为响应
 * 返回的 `key`，另有保留值 `@unattributed`（全部未归属）；`null`/缺失/空数组都表示不筛选。
 * 项目维度未采集时传非空筛选会得到错误码 `project_dimension_disabled`；本机项目索引读不出来时
 * 传非空筛选得到 `project_dimension_unavailable`。
 */
export interface BehaviorAnalysisRequest {
  query: Record<string, unknown>;
  projects?: string[] | null;
}

export interface BehaviorAnalysisResponse {
  meta: {
    source: 'local';
    complete: boolean;
    range: RangeKey;
    start: string;
    end: string;
    timezone: string;
    recordCount: number;
    firstRecordAt: string | null;
    lastRecordAt: string | null;
    sessionLimit: number;
    sessionsTruncated: boolean;
    /**
     * 契约 v1.1 只增字段：`all` 只覆盖截至今天的最近 `rangeDayLimit`（731）个本地日历日；
     * `rangeTruncated` 为 true 表示该窗口之前仍有符合同一过滤条件的本机记录。缺失表示旧后端。
     */
    rangeDayLimit?: number;
    rangeTruncated?: boolean;
    /** 契约 v1.2 只增字段：项目维度状态。缺失表示后端不支持项目维度或项目索引读不出来，不得读作关闭或 0。 */
    projectDimension?: BehaviorProjectDimensionMeta;
  };
  summary: {
    tokens: number;
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    requests: number;
    activeDays: number;
    toolCount: number;
    /** 只统计真实会话 ID；空值与 `unknown_session` 占位不计入（契约 v1.1）。 */
    sessionCount: number;
    modelCount: number;
    /**
     * 契约 v1.1 只增字段：缺少会话 ID 的入选记录数与其有效 Token（输入 + 输出）。
     * 当前原生后端总会返回；缺失表示响应来自旧后端或旧夹具，不得按 0 解读。
     */
    unknownSessionRecords?: number;
    unknownSessionTokens?: number;
    /**
     * 契约 v1.1 只增字段（D5①）：入选记录的预估费用合计（USD），与看板本机 `summary.totalCost`
     * 同源同口径。`null` 表示有记录缺少可用费用（此时 `costComplete` 为 false），不得显示为 0。
     */
    totalCost?: number | null;
    costComplete?: boolean;
  };
  /** `sessionCount` 同样不计缺少会话 ID 的记录；这些记录的 Token 与记录数仍归入所属工具。 */
  tools: Array<{
    id: string;
    tokens: number;
    requests: number;
    sessionCount: number;
    /**
     * 契约 v1.1 只增字段：该工具缺少会话 ID 的记录数。大于 0 时 `sessionCount` 不是完整会话数，
     * 界面须注明缺失；等于 `requests` 时会话未知，不得显示为 0 会话。缺失表示旧后端。
     */
    unknownSessionRecords?: number;
  }>;
  sessions: Array<{
    id: string;
    tool: string;
    tokens: number;
    requests: number;
    /** 契约 v1.1（D5①）：会话预估费用（USD）；`null` = 该会话有记录缺少可用费用，不得显示为 0。 */
    cost?: number | null;
    /** 会话在所选区间内首条与末条记录的时间：所选时区墙钟 `YYYY-MM-DD HH:MM:SS`。 */
    firstAt?: string;
    lastAt?: string;
    /**
     * 会话内有效 Token 最多的模型（同数取记录多者，再按模型名）。`null` 表示没有可认定的模型；
     * 当前后端对每个会话都给出值，但须按可空处理，不得显示成某个模型。
     */
    topModel?: string | null;
    /**
     * 契约 v1.2 只增字段，只在项目维度采集中时出现：会话所属项目；`null` 时 `projectReason`
     * 说明原因。与 `projects[]` 中同一会话的键一致。
     */
    project?: BehaviorProjectRef | null;
    projectReason?: BehaviorSessionProjectReason;
  }>;
  dayHours: Array<{ date: string; hour: number; tokens: number; requests: number }>;
  modelHours: Array<{ hour: number; model: string; tokens: number; requests: number }>;
  modelDays: Array<{ date: string; model: string; tokens: number; requests: number }>;
  requestSizes: Array<{ model: string; requests: number; p50: number; p90: number; max: number; bins: Array<{ lower: number; upper: number; requests: number }> }>;
  /**
   * 契约 v1.2 只增字段，只在项目维度采集中（`indexing`/`ready`/`failed`）时出现：项目排行按有效
   * Token 倒序、同值按 `key`，最多 `projectLimit`（50）个，其余合并进 `projectsRemainder`；
   * `unattributed` 是无法归属的用量。排行、余量与未归属三者之和等于 `summary` 的 Token、记录数与会话数。
   */
  projects?: BehaviorProject[];
  projectLimit?: number;
  projectsTruncated?: boolean;
  projectsRemainder?: BehaviorProjectsRemainder | null;
  unattributed?: BehaviorUnattributed;
}
export type ToastType = 'success' | 'warning' | 'error' | 'info';

export interface ToastMessage {
  type: ToastType;
  text: string;
}

export interface BusyState {
  scan: boolean;
  sync: boolean;
  wallpaper: boolean;
  auth: boolean;
  config: boolean;
  settings: boolean;
  prices: boolean;
  db: boolean;
}

export interface ModelsDevCandidate {
  providerId: string;
  providerName: string;
  modelId: string;
  modelName: string;
  input: number | null;
  output: number | null;
  cacheInput: number | null;
  cacheWrite: number | null;
  lastUpdated: string | null;
  status: string | null;
  hasTieredPricing: boolean;
  importable: boolean;
  matchReason: string;
}

export interface ModelsDevSearchResponse {
  query: string;
  candidates: ModelsDevCandidate[];
  fetchedAt: string;
  cacheStatus: 'fresh' | 'refreshed' | 'stale';
  warning: string | null;
}

/** 整理删掉、且删后单价变了的一项价格（T10.189）。单位：$/百万 Token。 */
export interface PriceMigrationChange {
  model: string;
  /** `input` | `output` | `cache_input` | `cache_write` */
  field: string;
  previous: number;
  /** 整理后的单价；`null` 表示该型号不再有自己的价格，改按工具兜底价估算，不得显示为 0。 */
  current: number | null;
}

/** 整理从某个型号删掉的价格字段；`wholeModel` 表示整行删除。 */
export interface PriceMigrationClearedModel {
  model: string;
  fields: string[];
  wholeModel: boolean;
}

/**
 * 旧版价格覆盖文件整理（T10.171）后设置页的一次性提示（T10.189，U-5、U-6），
 * 来自 `get_price_migration_notice`；没有要提示的整理时后端返回 `null`。
 */
export interface PriceMigrationNotice {
  /** 被整理文件的 SHA-256：同一文件的整理只提示一次，关闭时原样回传给 `dismiss_price_migration_notice`。 */
  id: string;
  /** 首次整理的时间，RFC 3339（UTC）。 */
  migratedAt: string;
  /** 原文件备份的文件名。 */
  backupFile: string;
  /** 备份所在目录，即本机的应用数据目录。 */
  backupDir: string;
  modelsCleared: number;
  fieldsCleared: number;
  cleared: PriceMigrationClearedModel[];
  /** 删后单价变了的那些；其余删掉的价格与现价相同。 */
  changed: PriceMigrationChange[];
}

export const DEFAULT_SETTINGS: AppSettings = {
  scan_interval_secs: 900,
  scan_policy_version: 1,
  desktop_interval_secs: 60,
  lockscreen_interval_secs: 300,
  wallpaper_desktop_enabled: false,
  wallpaper_lockscreen_enabled: false,
  wallpaper_consent_version: 1,
  autostart_enabled: false,
  start_minimized: false,
  widget_open_at_startup: false,
  tray_text_enabled: false,
  tray_hover_widget_enabled: true,
  tray_hover_delay_ms: 450,
  desktop_widget_enabled: false,
  widget_popover_layout: 'usage',
  widget_popover_theme: 'system',
  widget_popover_range: 'today',
  widget_popover_provider: null,
  widget_desktop_layout: 'usage',
  widget_desktop_theme: 'system',
  widget_desktop_range: 'today',
  widget_desktop_provider: null,
  desktop_widget_position: null,
  wallpaper_use_cloud: false,
  wallpaper_device_filter: 'all_cloud',
  wallpaper_dynamic_bg_enabled: false,
  quota_codex_local_enabled: false,
  quota_claude_enabled: false,
  quota_claude_statusline_enabled: false,
  quota_claude_codexbar_enabled: false,
  quota_antigravity_local_enabled: false,
  quota_antigravity_codexbar_enabled: false,
  quota_custom_endpoints: [],
  quota_snapshot_sync_enabled: false,
};

// Tool -> chart-slot mapping, shared with Android (T10.178, user decision
// V-Q6 in T10.173 round 3). Every tool identity resolves to one of the 8
// `--chart-1..8` slots defined in src/styles/tokens.css; several identities
// legitimately share a slot (e.g. codex/marvis/hermes all draw --chart-2) —
// that is by design, not a collision, unless they are shown side by side in
// one view (see `colorsForToolsInView` below). Mapping source:
// docs/design/android-visual-refresh-v2.md §3.8. Alias spellings of the same
// product (kimidesktop, mavis, deepseekgui, dsh) are resolved to their
// canonical name in `TOOL_ALIASES` below, before this table is consulted —
// they are deliberately not duplicated as keys here (review T10.178 P2-6 #2:
// a name kept only in this flat table, and not also in the shared alias list,
// would hash to a different slot on an end that has not registered it).
const TOOL_CHART_SLOT: Record<string, number> = {
  antigravity: 1,
  gemini: 1,
  codex: 2,
  marvis: 2,
  hermes: 2,
  pi: 3,
  opencode: 4,
  workbuddy: 4,
  reasonix: 5,
  deepseek: 5,
  grok: 5,
  claude: 6,
  qclaw: 6,
  kilo: 7,
  kimi: 7,
  trae: 7,
  minimax: 8,
  zcode: 8,
};

// Same-product spelling variants, resolved to their canonical name before
// `TOOL_CHART_SLOT` is consulted (R-8(b), root decision 2026-09-25 ~06:30).
// This table is the shared reference for both ends: Android copies it
// verbatim, so a tool spelled only as an alias lands on the same slot on
// both, instead of each end hashing the unregistered spelling independently.
const TOOL_ALIASES: Record<string, string> = {
  deepseekgui: 'deepseek',
  dsh: 'deepseek',
  kimidesktop: 'kimi',
  mavis: 'marvis',
};

const CHART_SLOT_COUNT = 8;

// Mirror of src/styles/tokens.css `--chart-1..8` (dark scope). colorForTool
// has no DOM access in unit tests, so it cannot read the CSS custom property
// at run time; keep this list in sync with tokens.css by hand, in the same
// commit, if those values ever change. T10.187 retuned these to colour-vision
// palette B (user decision U-4, 2026-09-25): every same-view pair of the 8
// slots now clears T10.161's colour-vision bar (deutan >=5.8, protan >=5.4,
// tritan >=3.3) under Machado 2009 severity-1.0 simulation, with a margin of
// about 10% (10.06% unquantised at the tightest pair; 8.1% for light protan
// once the simulated colour is rounded to 8-bit — docs/task-logs/T10.187/*).
// Android uses the same 8 values, in the same order (T10.177). The desktop
// static wallpaper (src-tauri/src/wallpaper.rs) keeps its own separate copy
// of the dark half rather than reading this table — a fixture equality test
// (fixtures/tool-chart-slots-v1/palette-b.json) holds this array, tokens.css,
// chartTheme.ts's fallback and the wallpaper's copy equal (T10.187 review
// P2-1, root decision R-39).
const CHART_SLOT_COLORS_DARK: readonly string[] = [
  '#6b9dff', '#907adc', '#2dd4bf', '#fbbf24', '#fb7185', '#3fe480', '#3dbdf7', '#fb923c',
];
// Mirror of src/styles/tokens.css `--chart-1..8` (light scope). See note above.
// All 8 also clear 3:1 against the bare page background #f4f5f7 (T10.187):
// the pre-T10.187 "light charts only ever draw on a card/panel" carve-out for
// chart-slot-4 no longer applies.
const CHART_SLOT_COLORS_LIGHT: readonly string[] = [
  '#2f6be6', '#8972fe', '#0d9488', '#d57501', '#d41340', '#16a34a', '#1d85c3', '#d34c04',
];

/** Lower-cases and trims a raw tool name (R-8(a)): the shared input both the hash and the alias table key on. */
function normalizeToolName(name: string): string {
  return (name || '').trim().toLowerCase();
}

/**
 * Stable, reproducible slot (1-8) for a tool name absent from
 * `TOOL_CHART_SLOT`. FNV-1a 32-bit over the UTF-16 code units of the already
 * normalised (trimmed, lower-cased) name, folded into range with `mod 8` (R-8(a)):
 * pure function of the string's characters only, so it does not depend on
 * iteration order, locale, or which other tools happen to be on screen — the
 * same unregistered name always lands on the same slot everywhere it is
 * drawn, in any view, on any run, and — because both ends hash the same
 * normalised bytes the same way — on Android too.
 */
function hashToolSlot(normalizedName: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < normalizedName.length; i += 1) {
    hash ^= normalizedName.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return ((hash >>> 0) % CHART_SLOT_COUNT) + 1;
}

/** The chart slot (1-8) a tool identity draws with, before same-view collision handling. */
export function toolChartSlot(name: string): number {
  const normalized = normalizeToolName(name);
  const resolved = TOOL_ALIASES[normalized] ?? normalized;
  return TOOL_CHART_SLOT[resolved] ?? hashToolSlot(resolved);
}

// `slot` must already be an integer in [1, CHART_SLOT_COUNT]; both callers
// (toolChartSlot's table/hash and assignToolChartSlots's wraparound) guarantee it.
function colorForSlot(slot: number, theme?: 'light' | 'dark'): string {
  const effectiveTheme = theme
    ?? (typeof document !== 'undefined' && document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark');
  const colors = effectiveTheme === 'light' ? CHART_SLOT_COLORS_LIGHT : CHART_SLOT_COLORS_DARK;
  return colors[slot - 1];
}

// Neutral "other" colour for the 9th+ ranked tool in one view (R-8(d)): not
// one of the 8 identity slots (would be indistinguishable from a real tool
// on that slot), and not a new chart token (out of this task's path
// ownership; tokens.css is single-writer) — mirrors the existing themed,
// already-contrast-checked muted-text token `--color-text-muted`.
const TOOL_COLOR_OTHER_DARK = '#a5acb9';
const TOOL_COLOR_OTHER_LIGHT = '#586273';

function colorForOther(theme?: 'light' | 'dark'): string {
  const effectiveTheme = theme
    ?? (typeof document !== 'undefined' && document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark');
  return effectiveTheme === 'light' ? TOOL_COLOR_OTHER_LIGHT : TOOL_COLOR_OTHER_DARK;
}

/** A tool's per-view slot assignment: 1-8, or `'other'` past the 8th distinct rank (R-8(d)). */
export type ToolChartSlotAssignment = number | 'other';

/**
 * Resolve chart slots for several distinct tools shown together in one view,
 * in rank order (index 0 = highest rank): the tool distribution donut, a
 * multi-series trend chart, a tool ranking list, a legend paired with one of
 * those. When two tools would land on the same `--chart-N` slot, the
 * lower-ranked one shifts to the next unused slot (wrapping 8 -> 1) —
 * guaranteed to find a free slot for up to 8 distinct tools (pigeonhole).
 * A 9th distinct tool onward draws the neutral "other" colour instead of
 * repeating (and being confused with) an already-placed primary slot (R-8(d));
 * the pairwise-distinct guarantee covers only the top 8 ranked tools.
 * Deterministic: the same `namesInRankOrder` always produces the same output.
 */
export function assignToolChartSlots(namesInRankOrder: readonly string[]): ToolChartSlotAssignment[] {
  const used = new Set<number>();
  return namesInRankOrder.map((name, index): ToolChartSlotAssignment => {
    if (index >= CHART_SLOT_COUNT) return 'other';
    let slot = toolChartSlot(name);
    while (used.has(slot)) {
      slot = slot >= CHART_SLOT_COUNT ? 1 : slot + 1;
    }
    used.add(slot);
    return slot;
  });
}

/** `assignToolChartSlots` resolved straight to colours for the given theme (current document theme when omitted). */
export function colorsForToolsInView(namesInRankOrder: readonly string[], theme?: 'light' | 'dark'): string[] {
  return assignToolChartSlots(namesInRankOrder).map((slot) => (slot === 'other' ? colorForOther(theme) : colorForSlot(slot, theme)));
}

/**
 * One colour assignment for a whole view's leaf items (a model bar, a
 * quadrant point, a log row, a session row), keyed by lower-cased tool name.
 * `namesInRankOrder` is the owning tool of each leaf item, in the view's rank
 * order, and may repeat (several models/rows can share one tool) — only the
 * first occurrence of a name fixes its rank, so repeats do not consume
 * another slot and every leaf item of that tool reads the same colour back.
 * An out-of-table name still goes through the same hash + same-view shift as
 * a registered one, so it never lands on a slot an earlier tool already took
 * (T10.178 review P1-1).
 */
export function toolColorMap(namesInRankOrder: readonly string[], theme?: 'light' | 'dark'): Map<string, string> {
  const distinct: string[] = [];
  const seen = new Set<string>();
  for (const name of namesInRankOrder) {
    const key = name.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      distinct.push(key);
    }
  }
  const colors = colorsForToolsInView(distinct, theme);
  const map = new Map<string, string>();
  distinct.forEach((key, index) => map.set(key, colors[index]));
  return map;
}

// Rank palettes for series that are not tools (BehaviorAnalysisView colours
// models by rank) and the ECharts default colour list; not used for tools.
// T10.206: rank/series bars draw these through barSeriesStyle's default alpha
// gradient (0.96 near axis -> 0.74 far axis, src/utils/chartTheme.ts), so every
// entry must clear 3:1 against its theme's panel at alpha 0.74, and light p4/p5
// must stay pairwise distinguishable under deuteranopia (see src/types.test.ts).
// Dark p3 and light p7 were lightened/darkened in place (same hue+saturation,
// only lightness moved) to clear 3:1 at 0.74 without collapsing into p1 under
// deutan/protan simulation; light p5 was darkened (hue/sat unchanged) to
// separate it from p4 under deuteranopia. Preserve each colour's hue family if
// retuning further.
export const PALETTE_DARK: readonly string[] = [
  '#0a84ff',
  '#30d158',
  '#9290ee',
  '#ffd60a',
  '#ff9f0a',
  '#ff375f',
  '#5ac8fa',
];

export const PALETTE_LIGHT: readonly string[] = [
  '#006dcc',
  '#15803d',
  '#4f46e5',
  '#b45309',
  '#a5370a',
  '#be123c',
  '#02689d',
];

// Dark rank palette under its historical name (kept for backward compatibility).
export const PALETTE = PALETTE_DARK;

export function getPalette(theme?: 'light' | 'dark'): readonly string[] {
  const effectiveTheme = theme
    ?? (typeof document !== 'undefined' && document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark');
  return effectiveTheme === 'light' ? PALETTE_LIGHT : PALETTE_DARK;
}

/**
 * Resolve one tool's identity colour for the given theme (current document
 * theme when omitted), with no notion of "view" or rank: `codex`, `marvis`
 * and `hermes` all resolve to the same `--chart-2` colour, by design (T10.178
 * slot table, shared with Android). `_index` is accepted and ignored — the
 * pre-T10.178 fallback-by-position parameter, kept only for call-site and
 * test-call compatibility (T10.178 review P3-4 defers removing it: every
 * production call now goes through `colorsForToolsInView`/`toolColorMap`
 * instead, but dropping the parameter would force a purely mechanical rewrite
 * of every positional test call for no behaviour change).
 *
 * Any view that shows more than one tool at once — several distinct
 * identities side by side (a distribution chart, a multi-series trend, a
 * ranking) or several leaf items each coloured by their owning tool (a model
 * bar, a quadrant point, a log row, a session row) — must resolve colours
 * with `colorsForToolsInView`/`toolColorMap` instead, so that two tools
 * landing on the same slot in that view are told apart by rank (T10.178
 * review P1-1). Calling `colorForTool` directly for a leaf item is only
 * correct when nothing else on screen might collide with it.
 */
export function colorForTool(name: string, _index = 0, theme?: 'light' | 'dark'): string {
  return colorForSlot(toolChartSlot(name), theme);
}
