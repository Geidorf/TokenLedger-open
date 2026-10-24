import { invoke } from '@tauri-apps/api/core';
import type { AppSettings } from '../../types';
import type { AgentApplyResult, AgentInspection, AgentPreview, AgentRestoreResult, CodexInspection, CoolingMember, GatewayStatus, HealthReport, LedgerRecord, ProviderRecord, ProviderView, RouteDecision, RoutingGroup } from './types';

export const gatewayStatus = () => invoke<GatewayStatus>('gateway_status');

/** 模型接入总开关（U-112）：落盘并启停网关监听，返回最新设置；不改任何 Agent 配置。 */
export const setModelAccess = (enabled: boolean) => invoke<AppSettings>('gateway_set_model_access', { enabled });

export const listProviders = () => invoke<ProviderView[]>('gateway_list_providers');

export const upsertProvider = (provider: ProviderRecord) =>
  invoke<ProviderView[]>('gateway_upsert_provider', { provider });

/** An empty key deletes the stored key. There is no command to read it back. */
export const setProviderKey = (id: string, key: string) =>
  invoke<void>('gateway_set_provider_key', { input: { id, key } });

export const deleteProvider = (id: string) => invoke<ProviderView[]>('gateway_delete_provider', { id });

/** The full local token, only for an explicit copy click: hand it to the clipboard and drop it. */
export const revealLocalToken = () => invoke<string>('gateway_reveal_local_token');

export const recentRequests = (limit = 50) => invoke<LedgerRecord[]>('gateway_recent_requests', { limit });

export const listRoutingGroups = () => invoke<RoutingGroup[]>('gateway_list_routing_groups');

export const upsertRoutingGroup = (group: RoutingGroup) =>
  invoke<RoutingGroup[]>('gateway_upsert_routing_group', { group });

export const deleteRoutingGroup = (id: string) => invoke<RoutingGroup[]>('gateway_delete_routing_group', { id });

export const providerHealth = () => invoke<HealthReport>('gateway_provider_health');

export const routingCooldowns = () => invoke<CoolingMember[]>('gateway_routing_cooldowns');

export const recentRouteDecisions = (limit = 30) =>
  invoke<RouteDecision[]>('gateway_recent_route_decisions', { limit });

export const codexInspect = () => invoke<CodexInspection>('gateway_codex_inspect');

export const codexPreview = (model: string) => invoke<AgentPreview>('gateway_codex_preview', { model });

export const codexApply = (model: string, expectedVersion?: string) =>
  invoke<AgentApplyResult>('gateway_codex_apply', { input: { model, expectedVersion } });

export const codexRestore = (force = false) => invoke<AgentRestoreResult>('gateway_codex_restore', { force });

export const agentInspect = (agent: string) => invoke<AgentInspection>('gateway_agent_inspect', { agent });

export const agentPreview = (agent: string, model: string) => invoke<AgentPreview>('gateway_agent_preview', { agent, model });

export const agentApply = (agent: string, model: string, expectedVersion?: string) =>
  invoke<AgentApplyResult>('gateway_agent_apply', { input: { agent, model, expectedVersion } });

export const agentRestore = (agent: string, force = false) => invoke<AgentRestoreResult>('gateway_agent_restore', { agent, force });

export function errorText(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  return '操作失败，请重试。';
}

export const legacyInspect = () => invoke<import('./types').LegacyInspection>('gateway_legacy_inspect');
export const legacyRestore = (receiptId: string, expectedVersion: string, keepCurrent = false) =>
  invoke<import('./types').LegacyInspection>('gateway_legacy_restore', { input: { receiptId, expectedVersion, keepCurrent } });
