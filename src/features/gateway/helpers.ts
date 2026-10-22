import type { LedgerRecord, ProviderView, RoutingGroup, RuleCondition, RuleKind } from './types';

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
    .map((group) => ({ value: `${GROUP_PREFIX}${group.id}`, label: group.name, section: '路由组', isGroup: true, providerId: null }));
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
      ? `{"model":"${model}","messages":[{"role":"user","content":"你好"}]}`
      : `{"model":"${model}","input":"你好"}`;
    return `curl ${baseUrl}${path} \\\n  -H "Authorization: Bearer ${token ?? TOKEN_PLACEHOLDER}" \\\n  -H "Content-Type: application/json" \\\n  -d '${body}'`;
  }
  if (lang === 'python') {
    const call = api === 'chat'
      ? `client.chat.completions.create(model="${model}",\n    messages=[{"role": "user", "content": "你好"}])`
      : `client.responses.create(model="${model}", input="你好")`;
    const head = token ? 'from openai import OpenAI' : 'import os\nfrom openai import OpenAI';
    return `${head}\nclient = OpenAI(base_url="${baseUrl}", api_key=${token ? `"${token}"` : 'os.environ["TOKENLEDGER_TOKEN"]'})\n${call}`;
  }
  const call = api === 'chat'
    ? `await client.chat.completions.create({ model: '${model}',\n  messages: [{ role: 'user', content: '你好' }] });`
    : `await client.responses.create({ model: '${model}', input: '你好' });`;
  return `import OpenAI from 'openai';\nconst client = new OpenAI({ baseURL: '${baseUrl}', apiKey: ${token ? `'${token}'` : 'process.env.TOKENLEDGER_TOKEN'} });\n${call}`;
}

export const RULE_KIND_LABEL: Record<RuleKind, string> = {
  hasImage: '带图片',
  inputCharsOver: '输入超过',
  reasoningEffort: '推理强度',
  agent: 'Agent',
  timeWindow: '时段',
  compact: '压缩对话',
};

export function ruleSummary(condition: RuleCondition): string {
  switch (condition.kind) {
    case 'hasImage': return '请求带图片';
    case 'inputCharsOver': return `输入超过 ${condition.chars.toLocaleString('zh-CN')} 字符`;
    case 'reasoningEffort': return `推理强度为 ${condition.efforts.join('、')}`;
    case 'agent': return `Agent 为 ${condition.agents.join('、')}`;
    case 'timeWindow': return `本地时间 ${condition.start}–${condition.end}`;
    case 'compact': return '压缩对话请求';
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

export const STRATEGY_LABEL: Record<RoutingGroup['strategy'], string> = {
  failover: '按顺序',
  rotate: '轮流',
  manual: '固定一个',
};

export const STRATEGY_HINT: Record<RoutingGroup['strategy'], string> = {
  failover: '总是先用第一个，失败才换下一个',
  rotate: '新会话轮流分给各成员，失败换下一个',
  manual: '只用选定的成员，规则暂停',
};

export const DECISION_REASON_LABEL: Record<string, string> = {
  rule: '规则',
  affinity: '会话保持',
  failover: '按顺序',
  rotate: '轮流',
  manual: '固定',
};

export const ATTEMPT_OUTCOME_LABEL: Record<string, string> = {
  ok: '成功',
  rejected: '上游拒绝',
  failed: '失败已切换',
  skipped: '跳过',
};

export const TTL_OPTIONS: { value: number; label: string }[] = [
  { value: 0, label: '关闭' },
  { value: 1800, label: '30 分钟' },
  { value: 3600, label: '1 小时' },
  { value: 21600, label: '6 小时' },
  { value: 86400, label: '1 天' },
];

export function ttlLabel(seconds: number): string {
  const option = TTL_OPTIONS.find((item) => item.value === seconds);
  if (option) return option.label;
  if (seconds % 3600 === 0) return `${seconds / 3600} 小时`;
  return `${Math.round(seconds / 60)} 分钟`;
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
