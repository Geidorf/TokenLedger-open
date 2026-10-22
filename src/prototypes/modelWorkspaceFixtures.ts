import type { BrandIconId } from './prototypeKit';

export type ProviderHealth = 'ok' | 'auth' | 'untested' | 'proxied';
export type WireApi = 'responses' | 'chat' | 'anthropic';

export interface PrototypeModel {
  id: string;
  name: string;
  context: string;
  reasoning: boolean;
  exposed: boolean;
}

export interface PrototypeProvider {
  id: string;
  icon: BrandIconId | null;
  enabled: boolean;
  name: string;
  monogram: string;
  tint: string;
  host: string;
  keyHint: string | null;
  health: ProviderHealth;
  apis: { api: WireApi; latencyMs: number | null; ok: boolean }[];
  models: PrototypeModel[];
  usedBy: string[];
  note?: string;
}

export interface PresetGroup {
  id: string;
  label: string;
  presets: { id: string; icon?: BrandIconId; name: string; monogram: string; tint: string; host: string; keyless?: boolean; custom?: boolean }[];
}

export const WIRE_LABEL: Record<WireApi, string> = {
  responses: 'Responses',
  chat: 'Chat Completions',
  anthropic: 'Anthropic Messages',
};

export const PROVIDERS: PrototypeProvider[] = [
  {
    id: 'openai',
    icon: 'openai',
    enabled: true,
    name: 'OpenAI',
    monogram: 'AI',
    tint: '#10a37f',
    host: 'api.openai.com',
    keyHint: 'sk-…7Q2c',
    health: 'ok',
    apis: [
      { api: 'responses', latencyMs: 412, ok: true },
      { api: 'chat', latencyMs: 368, ok: true },
    ],
    models: [
      { id: 'gpt-5.5', name: 'GPT-5.5', context: '400K', reasoning: true, exposed: true },
      { id: 'gpt-5.5-mini', name: 'GPT-5.5 mini', context: '400K', reasoning: true, exposed: true },
      { id: 'gpt-4.1', name: 'GPT-4.1', context: '1M', reasoning: false, exposed: false },
      { id: 'o4-mini', name: 'o4-mini', context: '200K', reasoning: true, exposed: false },
    ],
    usedBy: ['Codex'],
  },
  {
    id: 'openrouter',
    icon: 'openrouter',
    enabled: true,
    name: 'OpenRouter',
    monogram: 'OR',
    tint: '#6467f2',
    host: 'openrouter.ai',
    keyHint: 'sk-or-…a91e',
    health: 'ok',
    apis: [
      { api: 'chat', latencyMs: 655, ok: true },
      { api: 'responses', latencyMs: 702, ok: true },
    ],
    models: [
      { id: 'anthropic/claude-sonnet-5', name: 'Claude Sonnet 5', context: '1M', reasoning: true, exposed: true },
      { id: 'google/gemini-3.1-pro', name: 'Gemini 3.1 Pro', context: '2M', reasoning: true, exposed: true },
      { id: 'x-ai/grok-5', name: 'Grok 5', context: '256K', reasoning: true, exposed: false },
    ],
    usedBy: [],
  },
  {
    id: 'deepseek',
    icon: 'deepseek-color',
    enabled: true,
    name: 'DeepSeek',
    monogram: 'DS',
    tint: '#4d6bfe',
    host: 'api.deepseek.com',
    keyHint: 'sk-…f30b',
    health: 'ok',
    apis: [
      { api: 'chat', latencyMs: 286, ok: true },
      { api: 'anthropic', latencyMs: 301, ok: true },
    ],
    models: [
      { id: 'deepseek-chat', name: 'DeepSeek V4', context: '128K', reasoning: false, exposed: true },
      { id: 'deepseek-reasoner', name: 'DeepSeek V4 思考', context: '128K', reasoning: true, exposed: true },
    ],
    usedBy: [],
    note: '只提供 Chat Completions，Codex 经网关转换为 Responses 使用。',
  },
  {
    id: 'relay-demo',
    icon: null,
    enabled: true,
    name: '中转服务商',
    monogram: 'RX',
    tint: '#d97706',
    host: 'relay.example.com',
    keyHint: 'sk-…****',
    health: 'proxied',
    apis: [{ api: 'responses', latencyMs: 538, ok: true }],
    models: [
      { id: 'demo-model', name: 'demo-model', context: '—', reasoning: false, exposed: true },
    ],
    usedBy: [],
    note: '演示数据：域名解析到 198.18.5.223（代理 fake-ip 地址），HTTPS 证书校验通过，已放行。',
  },
  {
    id: 'kimi',
    icon: 'moonshot',
    enabled: true,
    name: 'Kimi',
    monogram: 'K',
    tint: '#111827',
    host: 'api.moonshot.cn',
    keyHint: 'sk-…0c4d',
    health: 'auth',
    apis: [{ api: 'chat', latencyMs: null, ok: false }],
    models: [
      { id: 'kimi-k3', name: 'Kimi K3', context: '256K', reasoning: true, exposed: true },
    ],
    usedBy: [],
    note: '供应商返回 401：key 无效或已过期。',
  },
  {
    id: 'ollama',
    icon: 'ollama',
    enabled: true,
    name: 'Ollama',
    monogram: 'OL',
    tint: '#525252',
    host: '127.0.0.1:11434',
    keyHint: null,
    health: 'untested',
    apis: [{ api: 'chat', latencyMs: null, ok: false }],
    models: [
      { id: 'qwen3-coder:30b', name: 'qwen3-coder:30b', context: '256K', reasoning: false, exposed: true },
    ],
    usedBy: [],
  },
  {
    id: 'groq',
    icon: 'groq',
    enabled: false,
    name: 'Groq',
    monogram: 'GQ',
    tint: '#f55036',
    host: 'api.groq.com',
    keyHint: 'gsk_…31aa',
    health: 'ok',
    apis: [{ api: 'chat', latencyMs: 190, ok: true }],
    models: [
      { id: 'llama-4-maverick', name: 'Llama 4 Maverick', context: '128K', reasoning: false, exposed: true },
    ],
    usedBy: [],
  },
];

export const PRESET_GROUPS: PresetGroup[] = [
  {
    id: 'global',
    label: '国际厂商',
    presets: [
      { id: 'openai', icon: 'openai', name: 'OpenAI', monogram: 'AI', tint: '#10a37f', host: 'api.openai.com' },
      { id: 'anthropic', icon: 'anthropic', name: 'Anthropic', monogram: 'A', tint: '#c96442', host: 'api.anthropic.com' },
      { id: 'gemini', icon: 'gemini-color', name: 'Google Gemini', monogram: 'G', tint: '#3b82f6', host: 'generativelanguage.googleapis.com' },
      { id: 'openrouter', icon: 'openrouter', name: 'OpenRouter', monogram: 'OR', tint: '#6467f2', host: 'openrouter.ai' },
      { id: 'xai', icon: 'xai', name: 'xAI', monogram: 'X', tint: '#0f172a', host: 'api.x.ai' },
      { id: 'mistral', icon: 'mistral-color', name: 'Mistral', monogram: 'M', tint: '#f97316', host: 'api.mistral.ai' },
      { id: 'groq', icon: 'groq', name: 'Groq', monogram: 'GQ', tint: '#f55036', host: 'api.groq.com' },
    ],
  },
  {
    id: 'cn',
    label: '国内厂商',
    presets: [
      { id: 'deepseek', icon: 'deepseek-color', name: 'DeepSeek', monogram: 'DS', tint: '#4d6bfe', host: 'api.deepseek.com' },
      { id: 'kimi', icon: 'moonshot', name: 'Kimi', monogram: 'K', tint: '#111827', host: 'api.moonshot.cn' },
      { id: 'glm', icon: 'zhipu-color', name: '智谱 GLM', monogram: 'Z', tint: '#2563eb', host: 'open.bigmodel.cn' },
      { id: 'qwen', icon: 'qwen-color', name: '通义千问', monogram: 'Q', tint: '#7c3aed', host: 'dashscope.aliyuncs.com' },
      { id: 'ark', name: '火山方舟', monogram: '火', tint: '#0ea5e9', host: 'ark.cn-beijing.volces.com' },
      { id: 'siliconflow', icon: 'siliconcloud-color', name: '硅基流动', monogram: 'SF', tint: '#8b5cf6', host: 'api.siliconflow.cn' },
    ],
  },
  {
    id: 'relay',
    label: '中转与自定义',
    presets: [
      { id: 'custom-openai', name: '自定义 OpenAI 兼容', monogram: '+', tint: '#64748b', host: '填写接口地址', custom: true },
      { id: 'custom-anthropic', name: '自定义 Anthropic 兼容', monogram: '+', tint: '#64748b', host: '填写接口地址', custom: true },
    ],
  },
  {
    id: 'local',
    label: '本地模型',
    presets: [
      { id: 'ollama', icon: 'ollama', name: 'Ollama', monogram: 'OL', tint: '#525252', host: '127.0.0.1:11434', keyless: true },
      { id: 'lmstudio', name: 'LM Studio', monogram: 'LM', tint: '#4338ca', host: '127.0.0.1:1234', keyless: true },
    ],
  },
];

export type Effort = 'low' | 'medium' | 'high';

export interface PrototypeAgent {
  id: string;
  name: string;
  icon: BrandIconId;
  version: string | null;
  configPath: string;
  supported: boolean;
  providerId: string | null;
  modelId: string | null;
  groupId: string | null;
  effort: Effort | null;
  note?: string;
}

export const AGENTS: PrototypeAgent[] = [
  { id: 'codex', name: 'Codex', icon: 'codex-color', version: '0.48.0', configPath: '~/.codex/config.toml', supported: true, providerId: null, modelId: null, groupId: 'coding', effort: 'medium' },
  { id: 'opencode', name: 'OpenCode', icon: 'opencode', version: '1.4.2', configPath: '~/.config/opencode/opencode.json', supported: true, providerId: 'deepseek', modelId: 'deepseek-chat', groupId: null, effort: null },
  { id: 'claude', name: 'Claude Code', icon: 'claudecode-color', version: '2.3.1', configPath: '~/.claude/settings.json', supported: false, providerId: null, modelId: null, groupId: null, effort: null, note: '需要 Anthropic Messages 协议转换，下一阶段接入' },
  { id: 'gemini', name: 'Gemini CLI', icon: 'geminicli-color', version: '0.19.0', configPath: '~/.gemini/settings.json', supported: false, providerId: null, modelId: null, groupId: null, effort: null, note: '需要 Gemini 协议转换，排在 Claude Code 之后' },
];

export type RoutingMode = 'smart' | 'order' | 'rotate' | 'usage' | 'manual';
export type Affinity = 'auto' | 'session' | 'turn' | 'off';

export const ROUTING_MODE_LABEL: Record<RoutingMode, string> = { smart: '智能', order: '顺序', rotate: '轮询', usage: '最少使用', manual: '手动' };
export const ROUTING_MODE_HINT: Record<RoutingMode, string> = {
  smart: '先用第一个，它限流、欠费或报错时依次换下一个；恢复后自动回来',
  order: '严格按顺序，前一个不可用才用下一个',
  rotate: '每次请求轮流换一个成员',
  usage: '优先用近一小时 Token 最少的成员',
  manual: '只用你选中的那个成员，其余和规则暂停',
};
export const AFFINITY_LABEL: Record<Affinity, string> = { auto: '自动（缓存划算就留在原成员）', session: '整个会话不换', turn: '一轮对话内不换', off: '不保持' };

export interface GroupMember {
  ref: string;
  providerId: string;
  modelId: string;
  label: string;
  icon: BrandIconId | null;
  on: boolean;
  state: 'ready' | 'resting' | 'auth';
  stateText?: string;
  share: number;
}

export interface GroupRule {
  id: string;
  when: string;
  kind: 'images' | 'tokens' | 'compact' | 'agent' | 'time' | 'effort';
  use: string;
}

export interface RoutingGroup {
  id: string;
  name: string;
  auto: boolean;
  mode: RoutingMode;
  affinity: Affinity;
  members: GroupMember[];
  rules: GroupRule[];
  usedBy: string[];
  requestsToday: number;
  failoversToday: number;
}

export const ROUTING_GROUPS: RoutingGroup[] = [
  {
    id: 'coding',
    name: '编码主力',
    auto: false,
    mode: 'smart',
    affinity: 'auto',
    usedBy: ['Codex'],
    requestsToday: 412,
    failoversToday: 3,
    members: [
      { ref: 'openai/gpt-5.5', providerId: 'openai', modelId: 'gpt-5.5', label: 'GPT-5.5', icon: 'openai', on: true, state: 'ready', share: 0.71 },
      { ref: 'openrouter/anthropic/claude-sonnet-5', providerId: 'openrouter', modelId: 'anthropic/claude-sonnet-5', label: 'Claude Sonnet 5', icon: 'openrouter', on: true, state: 'resting', stateText: '429 限流 · 约 4 分钟后恢复', share: 0.12 },
      { ref: 'openrouter/google/gemini-3.1-pro', providerId: 'openrouter', modelId: 'google/gemini-3.1-pro', label: 'Gemini 3.1 Pro', icon: 'openrouter', on: true, state: 'ready', share: 0.06 },
      { ref: 'deepseek/deepseek-chat', providerId: 'deepseek', modelId: 'deepseek-chat', label: 'DeepSeek V4', icon: 'deepseek-color', on: true, state: 'ready', share: 0.11 },
      { ref: 'kimi/kimi-k3', providerId: 'kimi', modelId: 'kimi-k3', label: 'Kimi K3', icon: 'moonshot', on: false, state: 'auth', stateText: '401 · 已停用', share: 0 },
    ],
    rules: [
      { id: 'r1', kind: 'images', when: '带图片', use: 'openai/gpt-5.5' },
      { id: 'r2', kind: 'tokens', when: '上下文 ≥ 200K', use: 'openrouter/google/gemini-3.1-pro' },
      { id: 'r3', kind: 'compact', when: '压缩对话（/compact）', use: 'deepseek/deepseek-chat' },
      { id: 'r4', kind: 'time', when: '工作日 22:00–08:00', use: 'deepseek/deepseek-chat' },
    ],
  },
  {
    id: 'cheap',
    name: '省钱档',
    auto: false,
    mode: 'order',
    affinity: 'session',
    usedBy: ['OpenCode'],
    requestsToday: 86,
    failoversToday: 0,
    members: [
      { ref: 'deepseek/deepseek-chat', providerId: 'deepseek', modelId: 'deepseek-chat', label: 'DeepSeek V4', icon: 'deepseek-color', on: true, state: 'ready', share: 0.93 },
      { ref: 'q1-relay/deepseek-flash', providerId: 'q1-relay', modelId: 'deepseek-flash', label: 'deepseek-flash · Q1 中转', icon: null, on: true, state: 'ready', share: 0.07 },
      { ref: 'ollama/qwen3-coder:30b', providerId: 'ollama', modelId: 'qwen3-coder:30b', label: 'qwen3-coder:30b · 本地', icon: 'ollama', on: true, state: 'ready', share: 0 },
    ],
    rules: [],
  },
  {
    id: 'claude-sonnet-5',
    name: 'claude-sonnet-5',
    auto: true,
    mode: 'smart',
    affinity: 'auto',
    usedBy: [],
    requestsToday: 0,
    failoversToday: 0,
    members: [
      { ref: 'openrouter/anthropic/claude-sonnet-5', providerId: 'openrouter', modelId: 'anthropic/claude-sonnet-5', label: 'OpenRouter', icon: 'openrouter', on: true, state: 'resting', stateText: '429 限流', share: 0 },
      { ref: 'anthropic/claude-sonnet-5', providerId: 'anthropic', modelId: 'claude-sonnet-5', label: 'Anthropic（未添加 key）', icon: 'anthropic', on: false, state: 'auth', stateText: '未添加', share: 0 },
    ],
    rules: [],
  },
];

export type DecisionKind = 'default' | 'rule' | 'affinity' | 'failover';

export interface RoutingDecision {
  time: string;
  agent: string;
  agentIcon: BrandIconId;
  group: string;
  to: string;
  toIcon: BrandIconId | null;
  kind: DecisionKind;
  reason: string;
  latencyMs: number;
  ok: boolean;
}

export const DECISION_LABEL: Record<DecisionKind, string> = { default: '默认', rule: '规则', affinity: '保持', failover: '切换' };

export const ROUTING_DECISIONS: RoutingDecision[] = [
  { time: '14:21:08', agent: 'Codex', agentIcon: 'codex-color', group: 'group/coding', to: 'GPT-5.5', toIcon: 'openai', kind: 'affinity', reason: '同一会话，缓存仍有效（命中 96K）', latencyMs: 2_810, ok: true },
  { time: '14:20:31', agent: 'Codex', agentIcon: 'codex-color', group: 'group/coding', to: 'GPT-5.5', toIcon: 'openai', kind: 'rule', reason: '规则「带图片」', latencyMs: 1_940, ok: true },
  { time: '14:18:02', agent: 'Codex', agentIcon: 'codex-color', group: 'group/coding', to: 'DeepSeek V4', toIcon: 'deepseek-color', kind: 'failover', reason: 'Kimi K3 返回 401，未发出任何回复，转下一个', latencyMs: 3_420, ok: true },
  { time: '14:16:44', agent: 'Codex', agentIcon: 'codex-color', group: 'group/coding', to: 'GPT-5.5', toIcon: 'openai', kind: 'failover', reason: 'Claude Sonnet 5 返回 429，休息 5 分钟', latencyMs: 2_204, ok: true },
  { time: '14:02:19', agent: 'OpenCode', agentIcon: 'opencode', group: 'group/cheap', to: 'DeepSeek V4', toIcon: 'deepseek-color', kind: 'default', reason: '顺序第 1 个可用', latencyMs: 2_150, ok: true },
  { time: '13:58:07', agent: 'Codex', agentIcon: 'codex-color', group: 'group/coding', to: 'DeepSeek V4', toIcon: 'deepseek-color', kind: 'rule', reason: '规则「压缩对话」', latencyMs: 4_880, ok: true },
];

export interface CatalogModel {
  id: string;
  name: string;
  icon: BrandIconId | null;
  isGroup: boolean;
  context: string;
  reasoning: boolean;
  images: boolean;
  via: string;
}

export const GATEWAY_CATALOG: CatalogModel[] = [
  { id: 'group/coding', name: '编码主力', icon: null, isGroup: true, context: '200K', reasoning: true, images: true, via: '4 个成员 · 智能' },
  { id: 'group/cheap', name: '省钱档', icon: null, isGroup: true, context: '128K', reasoning: false, images: false, via: '3 个成员 · 顺序' },
  { id: 'openai/gpt-5.5', name: 'GPT-5.5', icon: 'openai', isGroup: false, context: '400K', reasoning: true, images: true, via: 'OpenAI' },
  { id: 'openai/gpt-5.5-mini', name: 'GPT-5.5 mini', icon: 'openai', isGroup: false, context: '400K', reasoning: true, images: true, via: 'OpenAI' },
  { id: 'openrouter/anthropic/claude-sonnet-5', name: 'Claude Sonnet 5', icon: 'openrouter', isGroup: false, context: '1M', reasoning: true, images: true, via: 'OpenRouter' },
  { id: 'openrouter/google/gemini-3.1-pro', name: 'Gemini 3.1 Pro', icon: 'openrouter', isGroup: false, context: '2M', reasoning: true, images: true, via: 'OpenRouter' },
  { id: 'deepseek/deepseek-chat', name: 'DeepSeek V4', icon: 'deepseek-color', isGroup: false, context: '128K', reasoning: false, images: false, via: 'DeepSeek · Chat 转 Responses' },
  { id: 'deepseek/deepseek-reasoner', name: 'DeepSeek V4 思考', icon: 'deepseek-color', isGroup: false, context: '128K', reasoning: true, images: false, via: 'DeepSeek · Chat 转 Responses' },
  { id: 'q1-relay/deepseek-flash', name: 'deepseek-flash', icon: null, isGroup: false, context: '—', reasoning: false, images: false, via: 'Q1 中转' },
  { id: 'ollama/qwen3-coder:30b', name: 'qwen3-coder:30b', icon: 'ollama', isGroup: false, context: '256K', reasoning: false, images: false, via: 'Ollama · 本地' },
];
