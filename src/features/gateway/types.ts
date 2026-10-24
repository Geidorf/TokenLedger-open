// Mirrors src-tauri/src/gateway (camelCase over IPC). Provider keys never
// appear here: the frontend can set or delete a key, never read one back.

export type WireApi = 'responses' | 'chat' | 'anthropic';

export interface GatewayStatus {
  running: boolean;
  port: number;
  baseUrl?: string | null;
  tokenHint?: string | null;
  error?: string | null;
  providerCount: number;
  enabledCount: number;
}

export interface ProviderRecord {
  id: string;
  name: string;
  baseUrl: string;
  wire: WireApi;
  authMode?: 'key' | 'none';
  models: string[];
  enabled: boolean;
}

export interface ProviderView extends ProviderRecord {
  hasKey: boolean;
}

export interface LedgerRecord {
  ts: string;
  requestId: string;
  /** 同一逻辑请求可有多个计费尝试；兼容旧账本。 */
  logicalRequestId?: string | null;
  agent?: string | null;
  session?: string | null;
  endpoint: string;
  provider: string;
  requestedModel: string;
  upstreamModel: string;
  wire: string;
  stream: boolean;
  status: number;
  ok: boolean;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  latencyMs: number;
  error?: string | null;
  group?: string | null;
  member?: string | null;
}

export type RoutingStrategy = 'failover' | 'rotate' | 'manual' | 'weighted';

export type RuleCondition =
  | { kind: 'hasImage' }
  | { kind: 'inputCharsOver'; chars: number }
  | { kind: 'reasoningEffort'; efforts: string[] }
  | { kind: 'agent'; agents: string[] }
  | { kind: 'timeWindow'; start: string; end: string }
  | { kind: 'compact' };

export type RuleKind = RuleCondition['kind'];

export interface RoutingRule {
  condition: RuleCondition;
  member: string;
}

export interface RoutingGroup {
  id: string;
  name: string;
  strategy: RoutingStrategy;
  members: string[];
  manualMember?: string | null;
  rules: RoutingRule[];
  /** Member → weight 1–100 for `weighted`; a missing member weighs 1. */
  weights?: Record<string, number>;
  sessionTtlSecs: number;
  enabled: boolean;
}

/** A member tried after the others for now because it recently failed. */
export interface CoolingMember {
  member: string;
  remainingSecs: number;
  failures: number;
}

export interface RouteAttempt {
  member: string;
  outcome: 'ok' | 'rejected' | 'failed' | 'skipped' | string;
  status?: number | null;
  error?: string | null;
}

/**
 * Why one group member was chosen, tried, passed over or left out of a
 * decision. `reasons` are machine codes; unknown codes are shown as is.
 */
export interface MemberTrace {
  member: string;
  /** Position among the candidates; null when left out of the plan. */
  rank?: number | null;
  verdict: 'chosen' | 'failed' | 'rejected' | 'skipped' | 'not_reached' | 'excluded' | string;
  reasons: string[];
  detail?: string | null;
}

export interface RouteDecision {
  ts: string;
  requestId: string;
  group: string;
  session?: string | null;
  reason: 'rule' | 'affinity' | 'failover' | 'rotate' | 'manual' | string;
  detail: string;
  chosen?: string | null;
  attempts: RouteAttempt[];
  /** One entry per group member; absent from builds before the trace existed. */
  trace?: MemberTrace[];
}

/**
 * `gateway_routing_feed`: the redacted view the live routing stage draws in
 * the widget windows (no session, error body, decision detail or tokens).
 */
export type RoutingFeedDecision = Pick<RouteDecision, 'ts' | 'requestId' | 'group' | 'chosen'> & {
  attempts: Array<Pick<RouteAttempt, 'member' | 'outcome' | 'status'>>;
};
export type RoutingFeedRequest = Pick<LedgerRecord, 'ts' | 'requestId' | 'logicalRequestId' | 'agent' | 'provider' | 'requestedModel' | 'upstreamModel' | 'group' | 'status' | 'ok'>;
export interface RoutingFeed {
  running: boolean;
  decisions: RoutingFeedDecision[];
  requests: RoutingFeedRequest[];
}

export interface AgentBackup {
  createdAt: string;
  originalExisted: boolean;
  restorableWithoutForce: boolean;
}

/** Common shape of an Agent config writer's inspection (Codex first). */
export interface AgentInspection {
  agent?: string;
  configPath: string;
  exists: boolean;
  version: string;
  pointsToGateway: boolean;
  model?: string | null;
  backup?: AgentBackup | null;
  warnings: string[];
}

export interface CodexInspection extends AgentInspection {
  modelProvider?: string | null;
  activeProfile?: string | null;
}

export interface AgentPreview {
  configPath: string;
  changed: boolean;
  beforeVersion: string;
  diff: string;
  warnings: string[];
}

export interface AgentApplyResult {
  configPath: string;
  changed: boolean;
  version: string;
  backupCreated: boolean;
}

export interface AgentRestoreResult {
  configPath: string;
  removed: boolean;
  version: string;
}

export interface LegacyInspection {
  profileCount: number;
  receiptId: string | null;
  state: 'none' | 'pending' | 'active' | 'indeterminate' | 'restored' | 'kept';
  configVersion: string | null;
  canRestore: boolean;
  reason: string | null;
}
