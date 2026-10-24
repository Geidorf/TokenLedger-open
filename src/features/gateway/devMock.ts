// In-memory gateway backend for the browser dev preview only. Keys are
// tracked as a boolean, matching the real backend's write-only contract.
import type { AgentInspection, AgentPreview, CodexInspection, HealthBucket, HealthReport, HealthStats, LedgerRecord, ProviderView, RouteDecision, RoutingGroup } from './types';

const PORT = 3462;
const minutesAgo = (minutes: number) => new Date(Date.UTC(2026, 9, 3, 16, 30 - minutes, 12)).toISOString();

let providers: ProviderView[] = [
  { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', wire: 'responses', models: ['gpt-5', 'gpt-5-mini'], enabled: true, hasKey: true },
  { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', wire: 'chat', models: ['deepseek-chat', 'deepseek-reasoner'], enabled: true, hasKey: true },
  { id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', wire: 'chat', models: ['anthropic/claude-sonnet-4.5'], enabled: true, hasKey: false },
  { id: 'ollama', name: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1', wire: 'chat', models: ['qwen3-coder:30b'], enabled: false, hasKey: false },
];

let groups: RoutingGroup[] = [
  {
    id: 'coding',
    name: '编码主力',
    strategy: 'failover',
    members: ['openai/gpt-5', 'deepseek/deepseek-chat', 'openrouter/anthropic/claude-sonnet-4.5'],
    rules: [
      { condition: { kind: 'hasImage' }, member: 'openai/gpt-5' },
      { condition: { kind: 'inputCharsOver', chars: 120000 }, member: 'deepseek/deepseek-chat' },
    ],
    sessionTtlSecs: 3600,
    enabled: true,
  },
  { id: 'cheap', name: '便宜优先', strategy: 'rotate', members: ['deepseek/deepseek-chat', 'deepseek/deepseek-reasoner'], rules: [], sessionTtlSecs: 1800, enabled: true },
];

let requests: LedgerRecord[] = [
  { ts: minutesAgo(1), requestId: 'r6', agent: 'codex', session: 's1', endpoint: '/v1/responses', provider: 'openai', requestedModel: 'group/coding', upstreamModel: 'gpt-5', wire: 'responses', stream: true, status: 200, ok: true, input: 18234, output: 1420, cacheRead: 12288, cacheWrite: 0, latencyMs: 2310, group: 'coding', member: 'openai/gpt-5' },
  { ts: minutesAgo(4), requestId: 'r5', agent: 'codex', session: 's1', endpoint: '/v1/responses', provider: 'deepseek', requestedModel: 'group/coding', upstreamModel: 'deepseek-chat', wire: 'chat', stream: true, status: 200, ok: true, input: 9120, output: 860, cacheRead: 4096, cacheWrite: 0, latencyMs: 1830, group: 'coding', member: 'deepseek/deepseek-chat' },
  { ts: minutesAgo(9), requestId: 'r4', agent: null, session: null, endpoint: '/v1/chat/completions', provider: 'deepseek', requestedModel: 'deepseek/deepseek-reasoner', upstreamModel: 'deepseek-reasoner', wire: 'chat', stream: false, status: 200, ok: true, input: 512, output: 2048, cacheRead: 0, cacheWrite: 0, latencyMs: 6420 },
  { ts: minutesAgo(15), requestId: 'r3', agent: 'codex', session: 's0', endpoint: '/v1/responses', provider: 'openrouter', requestedModel: 'openrouter/anthropic/claude-sonnet-4.5', upstreamModel: 'anthropic/claude-sonnet-4.5', wire: 'chat', stream: true, status: 401, ok: false, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, latencyMs: 210, error: '上游返回 401' },
];

let decisions: RouteDecision[] = [
  { ts: minutesAgo(1), requestId: 'r6', group: 'coding', session: 's1', reason: 'rule', detail: '请求带图片', chosen: 'openai/gpt-5', attempts: [{ member: 'openai/gpt-5', outcome: 'ok', status: 200 }], trace: [
    { member: 'openai/gpt-5', rank: 0, verdict: 'chosen', reasons: ['rule_match', 'answered'], detail: '请求带图片' },
    { member: 'deepseek/deepseek-chat', rank: 1, verdict: 'not_reached', reasons: ['fallback', 'not_reached'], detail: null },
  ] },
  { ts: minutesAgo(4), requestId: 'r5', group: 'coding', session: 's1', reason: 'failover', detail: '按顺序', chosen: 'deepseek/deepseek-chat', attempts: [{ member: 'openai/gpt-5', outcome: 'failed', status: 429 }, { member: 'deepseek/deepseek-chat', outcome: 'ok', status: 200 }], trace: [
    { member: 'openai/gpt-5', rank: 0, verdict: 'failed', reasons: ['strategy_first', 'rate_limited'], detail: '上游返回 429 Too Many Requests' },
    { member: 'deepseek/deepseek-chat', rank: 1, verdict: 'chosen', reasons: ['fallback', 'answered'], detail: null },
  ] },
  { ts: minutesAgo(20), requestId: 'r2', group: 'cheap', session: 's9', reason: 'affinity', detail: '会话保持', chosen: 'deepseek/deepseek-reasoner', attempts: [{ member: 'deepseek/deepseek-reasoner', outcome: 'ok', status: 200 }] },
];

let codexModel: string | null = 'gpt-5-codex';
let codexOnGateway = false;
let codexBackup: CodexInspection['backup'] = null;
let codexVersion = 'v1';

function codexInspection(): CodexInspection {
  return {
    configPath: '~/.codex/config.toml',
    exists: true,
    version: codexVersion,
    pointsToGateway: codexOnGateway,
    modelProvider: codexOnGateway ? 'tokenledger' : 'openai',
    model: codexModel,
    activeProfile: null,
    backup: codexBackup,
    warnings: [],
  };
}

function codexPreview(model: string): AgentPreview {
  return {
    configPath: '~/.codex/config.toml',
    changed: model !== codexModel || !codexOnGateway,
    beforeVersion: codexVersion,
    diff: [
      '--- config.toml',
      '+++ config.toml',
      `-model = "${codexModel ?? ''}"`,
      `+model = "${model}"`,
      ...(codexOnGateway ? [] : ['-model_provider = "openai"', '+model_provider = "tokenledger"', '+', '+[model_providers.tokenledger]', '+name = "TokenLedger"', `+base_url = "http://127.0.0.1:${PORT}/v1"`, '+wire_api = "responses"', '+experimental_bearer_token = "<本地 token，已隐藏>"']),
    ].join('\n'),
    warnings: [],
  };
}

const fail = (message: string) => Promise.reject(message);

interface MockAgent {
  path: string;
  model: string | null;
  onGateway: boolean;
  backup: AgentInspection['backup'];
  version: number;
}

const AGENT_PATHS: Record<string, string> = {
  opencode: '~/.config/opencode/opencode.json',
  crush: '~/.config/crush/crush.json',
  'gemini-cli': '~/.gemini/settings.json',
  pi: '~/.pi/agent/models.json',
  'claude-code': '~/.claude/settings.json',
  zed: '~/.config/zed/settings.json',
  omp: '~/.omp/agent/models.yml',
  'kimi-cli': '~/.kimi/config.toml',
  hermes: '~/.hermes/config.yaml',
  goose: '~/.config/goose/config.yaml',
  'minimax-code': '~/.minimax/config.yaml',
  'oh-my-opencode': '~/.omo/omo.jsonc',
};
const agents: Record<string, MockAgent> = {};

function mockAgent(id: string): MockAgent | null {
  const path = AGENT_PATHS[id];
  if (!path) return null;
  agents[id] ??= { path, model: null, onGateway: false, backup: null, version: 1 };
  return agents[id];
}

function agentPreview(agent: MockAgent, model: string): AgentPreview {
  return {
    configPath: agent.path,
    changed: model !== agent.model || !agent.onGateway,
    beforeVersion: `v${agent.version}`,
    diff: [
      `--- ${agent.path}`,
      `+++ ${agent.path}`,
      ...(agent.onGateway ? [] : ['+  "tokenledger": {', `+    "baseURL": "http://127.0.0.1:${PORT}/v1",`, '+    "apiKey": "tl-…mock"', '+  }']),
      `+  "model": "tokenledger/${model}"`,
    ].join('\n'),
    warnings: [],
  };
}

function handleAgentMock(cmd: string, payload: Record<string, unknown>) {
  const id = String(payload.agent ?? (payload.input as { agent?: string } | undefined)?.agent ?? '');
  const agent = mockAgent(id);
  if (!agent) return fail(`暂不支持 Agent「${id}」。`);
  switch (cmd) {
    case 'gateway_agent_inspect':
      return { agent: id, configPath: agent.path, exists: agent.backup !== null, version: `v${agent.version}`, pointsToGateway: agent.onGateway, model: agent.model, backup: agent.backup, warnings: [] } satisfies AgentInspection;
    case 'gateway_agent_preview':
      return agentPreview(agent, String(payload.model));
    case 'gateway_agent_apply': {
      const { model } = payload.input as { model: string };
      const backupCreated = agent.backup === null;
      if (backupCreated) agent.backup = { createdAt: new Date().toISOString(), originalExisted: false, restorableWithoutForce: true };
      agent.model = model;
      agent.onGateway = true;
      agent.version += 1;
      return { configPath: agent.path, changed: true, version: `v${agent.version}`, backupCreated };
    }
    default:
      agent.model = null;
      agent.onGateway = false;
      agent.backup = null;
      agent.version += 1;
      return { configPath: agent.path, removed: true, version: `v${agent.version}` };
  }
}

/** First-launch preview (`?fresh=1`): no providers, groups or traffic yet. */
export function resetGatewayMockToFresh() {
  providers = [];
  groups = [];
  requests = [];
  decisions = [];
}

const NOW = Date.UTC(2026, 9, 3, 16, 30, 12);
const emptyStats = (): HealthStats => ({ requests: 0, ok: 0, successRate: null, p50Ms: null, p95Ms: null, rateLimited: 0, skipped: 0, codes: [], statuses: [], lastOkAt: null, lastFailureAt: null });

function mockBuckets(base: number, failEvery: number, p95: number): HealthBucket[] {
  const firstHour = Math.floor(NOW / 3_600_000) * 3_600_000 - 23 * 3_600_000;
  return Array.from({ length: 24 }, (_, hour) => {
    const requests = base === 0 ? 0 : base + ((hour * 7) % 11);
    const failed = failEvery > 0 && hour % failEvery === 0 ? Math.max(1, Math.round(requests / 4)) : 0;
    return { start: new Date(firstHour + hour * 3_600_000).toISOString(), requests, failed, p95Ms: requests > failed ? p95 + ((hour * 13) % 9) * 120 : null };
  });
}

/** Deterministic health for the preview: one healthy, one degraded, one never-used provider. */
function mockHealth(): HealthReport {
  const shapes: Record<string, { status: HealthReport['providers'][number]['status']; base: number; failEvery: number; p50: number; p95: number }> = {
    openai: { status: 'healthy', base: 18, failEvery: 0, p50: 1840, p95: 4210 },
    deepseek: { status: 'degraded', base: 12, failEvery: 3, p50: 2260, p95: 7380 },
  };
  const report = providers.map((provider) => {
    const shape = shapes[provider.id];
    if (!shape) {
      const stats = emptyStats();
      if (provider.enabled && !provider.hasKey && provider.authMode !== 'none') {
        stats.skipped = 2;
        stats.codes = [{ code: 'key_missing', count: 2 }];
        stats.statuses = [{ status: 401, count: 2 }];
        stats.lastFailureAt = minutesAgo(12);
      }
      const down = stats.skipped > 0;
      return {
        provider: provider.id, status: down ? 'down' as const : 'idle' as const, reasons: down ? ['key_missing'] : [], stats, models: [], buckets: mockBuckets(0, 0, 0),
        recentFailures: down ? [{ ts: minutesAgo(12), model: provider.models[0] ?? '', status: 401, code: 'key_missing', error: `供应商「${provider.name}」还没有设置 API key。` }] : [],
        cooling: [],
      };
    }
    const buckets = mockBuckets(shape.base, shape.failEvery, shape.p95);
    const requests = buckets.reduce((sum, bucket) => sum + bucket.requests, 0);
    const failed = buckets.reduce((sum, bucket) => sum + bucket.failed, 0);
    const rateLimited = Math.ceil(failed / 2);
    const stats: HealthStats = {
      requests, ok: requests - failed, successRate: requests ? (requests - failed) / requests : null, p50Ms: shape.p50, p95Ms: shape.p95, rateLimited, skipped: 0,
      codes: failed ? [{ code: 'rate_limited', count: rateLimited }, { code: 'upstream_failed', count: failed - rateLimited }] : [],
      statuses: failed ? [{ status: 429, count: rateLimited }, { status: 503, count: failed - rateLimited }] : [],
      lastOkAt: minutesAgo(1), lastFailureAt: failed ? minutesAgo(7) : null,
    };
    const degraded = shape.status === 'degraded';
    return {
      provider: provider.id, status: shape.status, reasons: degraded ? ['cooling_down', 'rate_limited'] : [], stats,
      models: provider.models.map((model, index) => ({ model, status: index === 0 ? shape.status : 'healthy' as const, stats: index === 0 ? stats : { ...emptyStats(), requests: 6, ok: 6, successRate: 1, p50Ms: shape.p50 + 900, p95Ms: shape.p95 + 1200, lastOkAt: minutesAgo(9) } })),
      buckets,
      recentFailures: degraded ? [
        { ts: minutesAgo(7), model: provider.models[0], status: 429, code: 'rate_limited', error: '上游返回 429 Too Many Requests：Rate limit reached, retry after 20s' },
        { ts: minutesAgo(46), model: provider.models[0], status: 503, code: 'upstream_failed', error: '上游返回 503 Service Unavailable：server overloaded' },
      ] : [],
      cooling: degraded ? [{ member: `${provider.id}/${provider.models[0]}`, remainingSecs: 42, failures: 2 }] : [],
    };
  });
  const rank = { down: 0, degraded: 1, healthy: 2, idle: 3 };
  report.sort((a, b) => rank[a.status] - rank[b.status] || a.provider.localeCompare(b.provider));
  return { generatedAt: new Date(NOW).toISOString(), windowHours: 24, providers: report };
}

/** Returns undefined when the command is not a gateway command. */
export function handleGatewayMock(cmd: string, payload: Record<string, unknown>): unknown {
  switch (cmd) {
    case 'gateway_legacy_inspect':
      return { profileCount: 0, receiptId: null, state: 'none', configVersion: null, canRestore: false, reason: null };
    case 'gateway_legacy_restore':
      return fail('匿名预览没有旧版恢复凭据。');
    case 'gateway_status': {
      const enabledCount = providers.filter((provider) => provider.enabled).length;
      const running = enabledCount > 0;
      return { running, port: PORT, baseUrl: running ? `http://127.0.0.1:${PORT}/v1` : null, tokenHint: running ? 'tl-…9e1a' : null, error: null, providerCount: providers.length, enabledCount };
    }
    case 'gateway_reveal_local_token':
      return 'tl-mock000000000000000000000000000000009e1a';
    case 'gateway_list_providers':
      return providers;
    case 'gateway_upsert_provider': {
      const record = payload.provider as Omit<ProviderView, 'hasKey'>;
      if (record.id === 'group') return fail('供应商 ID「group」留给路由组使用。');
      const existing = providers.find((provider) => provider.id === record.id);
      providers = existing
        ? providers.map((provider) => (provider.id === record.id ? { ...record, hasKey: provider.hasKey } : provider))
        : [...providers, { ...record, hasKey: false }];
      return providers;
    }
    case 'gateway_set_provider_key': {
      const { id, key } = payload.input as { id: string; key: string };
      providers = providers.map((provider) => (provider.id === id ? { ...provider, hasKey: key.trim().length > 0 } : provider));
      return null;
    }
    case 'gateway_delete_provider':
      providers = providers.filter((provider) => provider.id !== payload.id);
      return providers;
    case 'gateway_recent_requests':
      return requests;
    case 'gateway_list_routing_groups':
      return groups;
    case 'gateway_upsert_routing_group': {
      const group = payload.group as RoutingGroup;
      groups = groups.some((item) => item.id === group.id)
        ? groups.map((item) => (item.id === group.id ? group : item))
        : [...groups, group];
      return groups;
    }
    case 'gateway_delete_routing_group':
      groups = groups.filter((group) => group.id !== payload.id);
      return groups;
    case 'gateway_recent_route_decisions':
      return decisions;
    case 'gateway_routing_cooldowns':
      return [];
    case 'gateway_provider_health':
      return mockHealth();
    case 'gateway_routing_feed': {
      const running = providers.some((provider) => provider.enabled);
      if (!running) return { running, decisions: [], requests: [] };
      return {
        running,
        decisions: decisions.map(({ ts, requestId, group, chosen, attempts }) => ({
          ts, requestId, group, chosen, attempts: attempts.map(({ member, outcome, status }) => ({ member, outcome, status })),
        })),
        requests: requests.map(({ ts, requestId, logicalRequestId, agent, provider, requestedModel, upstreamModel, group, status, ok }) => ({
          ts, requestId, logicalRequestId, agent, provider, requestedModel, upstreamModel, group, status, ok,
        })),
      };
    }
    case 'gateway_codex_inspect':
      return codexInspection();
    case 'gateway_codex_preview':
      return codexPreview(String(payload.model));
    case 'gateway_codex_apply': {
      const { model } = payload.input as { model: string };
      if (!codexBackup) codexBackup = { createdAt: new Date().toISOString(), originalExisted: true, restorableWithoutForce: true };
      codexModel = model;
      codexOnGateway = true;
      codexVersion = `v${Number(codexVersion.slice(1)) + 1}`;
      return { configPath: '~/.codex/config.toml', changed: true, version: codexVersion, backupCreated: true };
    }
    case 'gateway_codex_restore':
      codexModel = 'gpt-5-codex';
      codexOnGateway = false;
      codexBackup = null;
      codexVersion = `v${Number(codexVersion.slice(1)) + 1}`;
      return { configPath: '~/.codex/config.toml', removed: false, version: codexVersion };
    case 'gateway_agent_inspect':
    case 'gateway_agent_preview':
    case 'gateway_agent_apply':
    case 'gateway_agent_restore':
      return handleAgentMock(cmd, payload);
    default:
      return undefined;
  }
}
