import type { BrandIconId } from '../../prototypes/prototypeKit';
import { agentApply, agentInspect, agentPreview, agentRestore, codexApply, codexInspect, codexPreview, codexRestore } from './api';
import type { AgentApplyResult, AgentInspection, AgentPreview, AgentRestoreResult } from './types';
import { t } from '../../i18n';

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
    get reason() { return t('agents.cline.reason'); },
    get where() { return t('agents.cline.where'); },
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
    get reason() { return t('agents.claudeDesktop.reason'); },
    get where() { return t('agents.claudeDesktop.where'); },
    get steps() {
      return (['agents.claudeDesktop.step1', 'agents.claudeDesktop.step2', 'agents.claudeDesktop.step3', 'agents.claudeDesktop.step4', 'agents.claudeDesktop.step5'] as const).map((key) => t(key));
    },
    fields: [
      { label: 'Inference provider', value: { kind: 'text', text: 'Gateway' } },
      { label: 'Gateway base URL', value: { kind: 'gatewayRoot' }, get hint() { return t('agents.claudeDesktop.baseUrlHint'); } },
      { label: 'Gateway API key', value: { kind: 'token' } },
      { label: 'Gateway auth scheme', value: { kind: 'text', text: 'Bearer' } },
      { get label() { return t('agents.claudeDesktop.models'); }, value: { kind: 'model' }, get hint() { return t('agents.claudeDesktop.modelsHint'); } },
    ],
    get notes() {
      return [t('agents.claudeDesktop.note1'), t('agents.claudeDesktop.note2')];
    },
  },
];

/** Later batches; the full list and reasons live in the T10.269 and T10.291 task logs. */
export const PENDING_AGENTS: PendingAgent[] = [
  { id: 'openchamber', name: 'OpenChamber', icon: 'opencode', monogram: 'CH', get note() { return t('agents.openchamber.note'); } },
];
