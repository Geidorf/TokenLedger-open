import type { BrandIconId } from '../../prototypes/prototypeKit';
import { agentApply, agentInspect, agentPreview, agentRestore, codexApply, codexInspect, codexPreview, codexRestore } from './api';
import type { AgentApplyResult, AgentInspection, AgentPreview, AgentRestoreResult } from './types';

/** One Agent config writer: back up, preview a diff, write atomically, restore. */
export interface AgentAdapter {
  id: string;
  name: string;
  icon: BrandIconId | null;
  monogram: string;
  inspect: () => Promise<AgentInspection>;
  preview: (model: string) => Promise<AgentPreview>;
  apply: (model: string, expectedVersion?: string) => Promise<AgentApplyResult>;
  restore: (force: boolean) => Promise<AgentRestoreResult>;
}

export interface PendingAgent {
  id: string;
  name: string;
  icon: BrandIconId | null;
  monogram: string;
  note: string;
}

/** An Agent served by the generic JSON/TOML/YAML writer (`gateway_agent_*`). */
export function jsonAgent(id: string, name: string, icon: BrandIconId | null, monogram: string): AgentAdapter {
  return {
    id,
    name,
    icon,
    monogram,
    inspect: () => agentInspect(id),
    preview: (model) => agentPreview(id, model),
    apply: (model, expectedVersion) => agentApply(id, model, expectedVersion),
    restore: (force) => agentRestore(id, force),
  };
}

export const SUPPORTED_AGENTS: AgentAdapter[] = [
  { id: 'codex', name: 'Codex', icon: 'codex-color', monogram: 'CX', inspect: codexInspect, preview: codexPreview, apply: codexApply, restore: codexRestore },
  jsonAgent('opencode', 'OpenCode', 'opencode', 'OC'),
  jsonAgent('crush', 'Crush', null, 'CR'),
  jsonAgent('pi', 'Pi', null, 'PI'),
  jsonAgent('claude-code', 'Claude Code', 'claudecode-color', 'CC'),
  jsonAgent('omp', 'Oh My Pi', null, 'OP'),
  jsonAgent('kimi-cli', 'Kimi CLI', 'kimi', 'KM'),
  jsonAgent('hermes', 'Hermes', null, 'HM'),
  jsonAgent('goose', 'Goose', null, 'GS'),
  jsonAgent('zed', 'Zed', null, 'ZD'),
  jsonAgent('minimax-code', 'MiniMax Code', null, 'MM'),
  jsonAgent('gemini-cli', 'Gemini CLI', 'geminicli-color', 'GM'),
  jsonAgent('oh-my-opencode', 'oh-my-opencode', 'opencode', 'OM'),
];

/** One field the user copies into the Agent's own settings screen. */
export interface ManualField {
  label: string;
  /**
   * What to fill in: a fixed text, or a gateway value resolved at render time.
   * `baseUrl` is the OpenAI-style address ending in `/v1`; `gatewayRoot` drops
   * that suffix for clients that append `/v1/messages` themselves.
   */
  value: { kind: 'text'; text: string } | { kind: 'baseUrl' } | { kind: 'gatewayRoot' } | { kind: 'token' } | { kind: 'model' };
  hint?: string;
}

/** An Agent whose config store cannot be written safely; the page shows copyable settings instead. */
export interface ManualAgent {
  id: string;
  name: string;
  icon: BrandIconId | null;
  monogram: string;
  reason: string;
  where: string;
  /** Ordered steps shown before the fields when one sentence is not enough. */
  steps?: string[];
  fields: ManualField[];
  /** Limits to know before switching. */
  notes?: string[];
}

export const MANUAL_AGENTS: ManualAgent[] = [
  {
    id: 'cline',
    name: 'Cline',
    icon: null,
    monogram: 'CL',
    reason: 'Cline 把供应商设置存在编辑器扩展的内部存储里，格式未公开，扩展运行时还会覆盖外部写入，所以不自动写入。',
    where: '在编辑器里打开 Cline → 设置（齿轮）→ API Configuration，按下面逐项填写后保存。',
    fields: [
      { label: 'API Provider', value: { kind: 'text', text: 'OpenAI Compatible' } },
      { label: 'Base URL', value: { kind: 'baseUrl' } },
      { label: 'API Key', value: { kind: 'token' } },
      { label: 'Model ID', value: { kind: 'model' } },
    ],
  },
  {
    id: 'claude-desktop',
    name: 'Claude Desktop',
    icon: 'claude-color',
    monogram: 'CD',
    reason: 'Claude Desktop 的第三方推理设置由应用内表单写入，存储格式未公开为可编辑文件，所以不自动写入。',
    where: '在 Claude Desktop 的第三方推理配置窗口里按下面的步骤填写。',
    steps: [
      '菜单栏（Windows 为左上角 ☰ 菜单）选 Help → Troubleshooting → Enable Developer Mode，应用会带 Developer 菜单重启。',
      '打开 Developer → Configure Third-Party Inference…，在 Connection 里把 Inference provider 选为 Gateway。',
      '在 Gateway credentials 里填入下面的地址和本地 token，Credential kind 保持 Static API key，Gateway auth scheme 保持 Bearer。',
      '在 Models 里的模型列表（inferenceModels）手动添加下面选中的模型名：网关模型名不是 Claude 官方名字，自动发现会把它过滤掉。列表第一个是默认模型。',
      '点 Apply Changes，应用重启后生效。',
    ],
    fields: [
      { label: 'Inference provider', value: { kind: 'text', text: 'Gateway' } },
      { label: 'Gateway base URL', value: { kind: 'gatewayRoot' }, hint: '填根地址，不带 /v1，Claude Desktop 会自己拼接 /v1/messages。' },
      { label: 'Gateway API key', value: { kind: 'token' } },
      { label: 'Gateway auth scheme', value: { kind: 'text', text: 'Bearer' } },
      { label: '模型列表', value: { kind: 'model' }, hint: '选一个模型复制，添加到 Models 的模型列表里；可以添加多个。' },
    ],
    notes: [
      '启用第三方推理后，Claude Desktop 只运行本机会话，不使用 Claude 订阅账号，也不提供云端环境与 Remote Control。',
      '如果设备上有组织下发的托管配置，它会覆盖本地表单，配置窗口也会变成只读。',
    ],
  },
];

/** Later batches; the full list and reasons live in the T10.269 and T10.291 task logs. */
export const PENDING_AGENTS: PendingAgent[] = [
  { id: 'openchamber', name: 'OpenChamber', icon: 'opencode', monogram: 'CH', note: '运行在 OpenCode 之上，接入上方 OpenCode 即生效，无需单独写入' },
];
