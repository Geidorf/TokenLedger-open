import type { LedgerRecord, ProviderView, RoutingGroup, RuleCondition, RuleKind } from './types';
import { formatCount, localized, MESSAGES, t } from '../../i18n';

export const GATEWAY_PORT = 3462;
export const DEFAULT_BASE_URL = `http://127.0.0.1:${GATEWAY_PORT}/v1`;
export const GROUP_PREFIX = 'group/';
/** Placeholder shown wherever a client needs the local token. */
export const TOKEN_PLACEHOLDER = '$TOKENLEDGER_TOKEN';

export interface ModelOption {
  /** What the gateway accepts as `model`: `provider/model` or `group/<id>`. */
  value: string;
  label: string;
  section: string;
  isGroup: boolean;
  /** Provider id, or null for routing groups. */
  providerId: string | null;
}

/** Enabled providers' declared models plus enabled routing groups. */
export function modelOptions(providers: ProviderView[], groups: RoutingGroup[]): ModelOption[] {
  const groupOptions = groups
    .filter((group) => group.enabled)
    .map((group) => ({ value: `${GROUP_PREFIX}${group.id}`, label: group.name, section: t('gateway.options.groupSection'), isGroup: true, providerId: null }));
  const providerOptions = providers
    .filter((provider) => provider.enabled)
    .flatMap((provider) => provider.models.map((model) => ({
      value: `${provider.id}/${model}`,
      label: model,
      section: provider.name,
      isGroup: false,
      providerId: provider.id,
    })));
  return [...groupOptions, ...providerOptions];
}

/** Splits a free-form model list (commas, spaces or new lines), keeping order. */
export function parseModels(text: string): string[] {
  const seen = new Set<string>();
  return text.split(/[\s,，]+/).map((item) => item.trim()).filter((item) => {
    if (!item || seen.has(item)) return false;
    seen.add(item);
    return true;
  });
}

/** Lower-case id the backend accepts: 1–32 of a–z, 0–9 and '-'. */
export function slugId(text: string, taken: string[] = []): string {
  const base = text.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 28) || 'provider';
  if (!taken.includes(base)) return base;
  for (let index = 2; index < 100; index += 1) {
    const candidate = `${base}-${index}`;
    if (!taken.includes(candidate)) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`.slice(0, 32);
}

export type SampleApi = 'responses' | 'chat';
export type SampleLang = 'curl' | 'python' | 'node';

/** Client snippet; the token is always a placeholder, never the real value. */
/** Without `token` the sample reads it from `TOKENLEDGER_TOKEN`; only the copy action passes the real one. */
export function codeSample(api: SampleApi, lang: SampleLang, baseUrl: string, model: string, token?: string): string {
  const path = api === 'chat' ? '/chat/completions' : '/responses';
  if (lang === 'curl') {
    const body = api === 'chat'
      ? `{"model":"${model}","messages":[{"role":"user","content":"${t('gateway.sample.prompt')}"}]}`
      : `{"model":"${model}","input":"${t('gateway.sample.prompt')}"}`;
    return `curl ${baseUrl}${path} \\\n  -H "Authorization: Bearer ${token ?? TOKEN_PLACEHOLDER}" \\\n  -H "Content-Type: application/json" \\\n  -d '${body}'`;
  }
  if (lang === 'python') {
    const call = api === 'chat'
      ? `client.chat.completions.create(model="${model}",\n    messages=[{"role": "user", "content": "${t('gateway.sample.prompt')}"}])`
      : `client.responses.create(model="${model}", input="${t('gateway.sample.prompt')}")`;
    const head = token ? 'from openai import OpenAI' : 'import os\nfrom openai import OpenAI';
    return `${head}\nclient = OpenAI(base_url="${baseUrl}", api_key=${token ? `"${token}"` : 'os.environ["TOKENLEDGER_TOKEN"]'})\n${call}`;
  }
  const call = api === 'chat'
    ? `await client.chat.completions.create({ model: '${model}',\n  messages: [{ role: 'user', content: '${t('gateway.sample.prompt')}' }] });`
    : `await client.responses.create({ model: '${model}', input: '${t('gateway.sample.prompt')}' });`;
  return `import OpenAI from 'openai';\nconst client = new OpenAI({ baseURL: '${baseUrl}', apiKey: ${token ? `'${token}'` : 'process.env.TOKENLEDGER_TOKEN'} });\n${call}`;
}

export const RULE_KIND_LABEL: Record<RuleKind, string> = localized({
  hasImage: 'routing.ruleKind.hasImage',
  inputCharsOver: 'routing.ruleKind.inputCharsOver',
  reasoningEffort: 'routing.ruleKind.reasoningEffort',
  agent: 'routing.ruleKind.agent',
  timeWindow: 'routing.ruleKind.timeWindow',
  compact: 'routing.ruleKind.compact',
});

export function ruleSummary(condition: RuleCondition): string {
  switch (condition.kind) {
    case 'hasImage': return t('routing.rule.hasImage');
    case 'inputCharsOver': return t('routing.rule.inputCharsOver', { chars: formatCount(condition.chars) });
    case 'reasoningEffort': return t('routing.rule.reasoningEffort', { efforts: condition.efforts.join(t('routing.rule.listSeparator')) });
    case 'agent': return t('routing.rule.agent', { agents: condition.agents.join(t('routing.rule.listSeparator')) });
    case 'timeWindow': return t('routing.rule.timeWindow', { start: condition.start, end: condition.end });
    case 'compact': return t('routing.rule.compact');
  }
}

export function defaultCondition(kind: RuleKind): RuleCondition {
  switch (kind) {
    case 'hasImage': return { kind };
    case 'inputCharsOver': return { kind, chars: 60000 };
    case 'reasoningEffort': return { kind, efforts: ['high'] };
    case 'agent': return { kind, agents: ['codex'] };
    case 'timeWindow': return { kind, start: '09:00', end: '18:00' };
    case 'compact': return { kind };
  }
}

export const STRATEGY_LABEL: Record<RoutingGroup['strategy'], string> = localized({
  failover: 'routing.strategy.failover',
  rotate: 'routing.strategy.rotate',
  manual: 'routing.strategy.manual',
  weighted: 'routing.strategy.weighted',
});

export const STRATEGY_HINT: Record<RoutingGroup['strategy'], string> = localized({
  failover: 'routing.strategyHint.failover',
  rotate: 'routing.strategyHint.rotate',
  manual: 'routing.strategyHint.manual',
  weighted: 'routing.strategyHint.weighted',
});

export const MAX_WEIGHT = 100;

export function memberWeight(group: Pick<RoutingGroup, 'weights'>, member: string): number {
  return group.weights?.[member] ?? 1;
}

/** Each member's share of new sessions under `weighted`, in percent. */
export function weightShare(group: Pick<RoutingGroup, 'weights' | 'members'>, member: string): number {
  const total = group.members.reduce((sum, item) => sum + memberWeight(group, item), 0);
  return total === 0 ? 0 : Math.round((memberWeight(group, member) / total) * 100);
}

const DECISION_REASON_KEYS = {
  rule: 'routing.reason.rule',
  affinity: 'routing.reason.affinity',
  failover: 'routing.strategy.failover',
  rotate: 'routing.strategy.rotate',
  manual: 'routing.reason.manual',
  weighted: 'routing.strategy.weighted',
} as const;

export const DECISION_REASON_LABEL: Record<string, string> = localized(DECISION_REASON_KEYS);

/**
 * The decision's detail line, or null when it only repeats the reason chip.
 * The gateway writes details in Chinese, so an echo is caught in either language.
 */
export function decisionDetail(decision: { reason: string; detail: string }): string | null {
  const key = DECISION_REASON_KEYS[decision.reason as keyof typeof DECISION_REASON_KEYS];
  const echoes = key ? [MESSAGES.zh[key], MESSAGES.en[key]] : [decision.reason];
  return echoes.includes(decision.detail) ? null : decision.detail;
}

export const ATTEMPT_OUTCOME_LABEL: Record<string, string> = localized({
  ok: 'routing.attempt.ok',
  rejected: 'routing.attempt.rejected',
  failed: 'routing.attempt.failed',
  skipped: 'routing.attempt.skipped',
});

export const TRACE_VERDICT_LABEL: Record<string, string> = localized({
  chosen: 'routing.verdict.chosen',
  failed: 'routing.attempt.failed',
  rejected: 'routing.attempt.rejected',
  skipped: 'routing.attempt.skipped',
  not_reached: 'routing.verdict.notReached',
  excluded: 'routing.verdict.excluded',
});

/** Reason codes from the gateway's decision trace (routing.rs build_trace). */
export const TRACE_REASON_LABEL: Record<string, string> = localized({
  rule_match: 'routing.trace.rule_match',
  affinity: 'routing.reason.affinity',
  strategy_first: 'routing.trace.strategy_first',
  rotate_turn: 'routing.trace.rotate_turn',
  weighted_pick: 'routing.trace.weighted_pick',
  manual_pick: 'routing.trace.manual_pick',
  fallback: 'routing.trace.fallback',
  nested: 'routing.trace.nested',
  answered: 'routing.trace.answered',
  rate_limited: 'routing.trace.rate_limited',
  quota_exhausted: 'routing.trace.quota_exhausted',
  connect_failed: 'routing.trace.connect_failed',
  upstream_failed: 'routing.trace.upstream_failed',
  upstream_rejected: 'routing.attempt.rejected',
  auth_failed: 'routing.trace.auth_failed',
  provider_missing: 'routing.trace.provider_missing',
  key_missing: 'routing.trace.key_missing',
  protocol_unsupported: 'routing.trace.protocol_unsupported',
  credential_unavailable: 'routing.trace.credential_unavailable',
  not_reached: 'routing.trace.not_reached',
  manual_only: 'routing.trace.manual_only',
  cooling_down: 'routing.trace.cooling_down',
  unhealthy: 'routing.trace.unhealthy',
  disabled: 'routing.trace.disabled',
  not_planned: 'routing.trace.not_planned',
  probe_unsupported: 'routing.trace.probe_unsupported',
});

/** Codes that say why a member could not serve, for compact one-line hints. */
const TRACE_PROBLEM_CODES = new Set([
  'rate_limited', 'quota_exhausted', 'connect_failed', 'upstream_failed', 'upstream_rejected', 'auth_failed',
  'provider_missing', 'key_missing', 'protocol_unsupported', 'credential_unavailable', 'cooling_down', 'unhealthy', 'disabled',
]);

export function traceReasonLabel(code: string): string {
  return TRACE_REASON_LABEL[code] ?? code;
}

/** The most telling reason of one member: its problem if it had one, else why it was ranked. */
export function traceHeadline(reasons: string[]): string | null {
  const problem = reasons.find((code) => TRACE_PROBLEM_CODES.has(code));
  const code = problem ?? reasons[0];
  return code ? traceReasonLabel(code) : null;
}

export const TTL_OPTIONS: { value: number; label: string }[] = [
  { value: 0, get label() { return t('routing.ttl.off'); } },
  { value: 1800, get label() { return t('routing.ttl.minutes', { count: 30 }); } },
  { value: 3600, get label() { return t('routing.ttl.hours', { count: 1 }); } },
  { value: 21600, get label() { return t('routing.ttl.hours', { count: 6 }); } },
  { value: 86400, get label() { return t('routing.ttl.day'); } },
];

export function ttlLabel(seconds: number): string {
  const option = TTL_OPTIONS.find((item) => item.value === seconds);
  if (option) return option.label;
  if (seconds % 3600 === 0) return t('routing.ttl.hours', { count: seconds / 3600 });
  return t('routing.ttl.minutes', { count: Math.round(seconds / 60) });
}

/** Effective tokens = input + output; cache reads/writes stay separate. */
export function effectiveTokens(record: Pick<LedgerRecord, 'input' | 'output'>): number {
  return record.input + record.output;
}

export function diffLineClass(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---')) return 'is-ctx';
  if (line.startsWith('+')) return 'is-add';
  if (line.startsWith('-')) return 'is-del';
  return 'is-ctx';
}

export function shortTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
