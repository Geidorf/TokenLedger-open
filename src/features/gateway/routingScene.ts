// The live routing scene: Agent → gateway → provider/account, built from
// sources that already exist and laid out without the DOM, so the desktop
// stage, the widget panel and the Android Routing page / live wallpaper can
// all draw the same thing (see docs/design/routing-animation.md).
//
// Honesty rules (the scene never invents traffic):
// - A flow exists only for a real record: a RouteDecision, a finished ledger
//   record, or a request an external local gateway reports as in flight.
// - A RouteDecision whose member answered 2xx means the request was routed
//   and the response started, not that it finished: a stream can still be
//   running. Such a flow is `routed`, never `done`.
// - No reachable source → `empty: 'no-source'`, and the stage shows an empty
//   state instead of an idle animation.

import { GROUP_PREFIX } from './helpers';
import type { RoutingFeedDecision, RoutingFeedRequest } from './types';

/** How long a finished flow stays lit on the stage (12 s). */
export const FLOW_LINGER_MS = 12_000;
/** Most agents / targets drawn; the rest fold into a "+N" node. */
export const MAX_AGENTS = 4;
export const MAX_TARGETS = 5;

export type SceneSourceId = 'tokenledger' | 'external';

/** Live snapshot of an external local gateway (its contract lives under docs/contracts/). */
export interface ExternalLiveRequest {
  id: string;
  agent?: string | null;
  model?: string | null;
  provider?: string | null;
  started?: string | null;
  ms?: number | null;
  phase?: 'slot' | 'rpm' | 'upstream' | string | null;
}

export interface ExternalRouteAttempt {
  provider: string;
  outcome: 'ok' | 'failed' | 'rejected' | string;
  status?: number | null;
}

/** A finished request, newest first; one attempt per upstream tried. */
export interface ExternalRecentRoute {
  id: string;
  agent?: string | null;
  model?: string | null;
  ended?: string | null;
  attempts: ExternalRouteAttempt[];
}

export interface ExternalLiveSnapshot {
  reachable: boolean;
  port?: number;
  requests?: number;
  waiting?: number;
  tools?: number;
  active: ExternalLiveRequest[];
  recent?: ExternalRecentRoute[];
}

export interface SceneSourceState {
  id: SceneSourceId;
  /** The source answered this round. */
  reachable: boolean;
  /** Short reason when not reachable, e.g. 网关未运行. */
  note?: string;
  /** The read itself failed (not the same as the gateway being stopped). */
  readError?: boolean;
}

export type HopOutcome = 'ok' | 'failed' | 'rejected' | 'skipped' | 'pending';

export interface SceneHop {
  target: string;
  outcome: HopOutcome;
  status?: number | null;
}

/**
 * - `inflight`: the gateway is still choosing or waiting (external gateway phase).
 * - `routed`: a member accepted it and the answer started; may still stream.
 * - `done`: finished and answered (ledger record, ok).
 * - `failed`: no member answered, or the finished request failed.
 */
export type FlowPhase = 'inflight' | 'routed' | 'done' | 'failed';

export interface SceneFlow {
  id: string;
  source: SceneSourceId;
  agent: string;
  /** `group/<id>` or the requested model for a direct request. */
  via: string;
  hops: SceneHop[];
  phase: FlowPhase;
  /** Epoch ms of the record. */
  at: number;
  /** What an in-flight request waits on: slot / rpm / upstream. */
  waitingOn?: string | null;
  /** The record is recent enough to play (younger than FLOW_LINGER_MS). */
  fresh: boolean;
}

export interface SceneNode {
  id: string;
  label: string;
  /** Folded "+N" node. */
  more?: number;
  /** Latest outcome seen on this node, for its status dot. */
  state?: 'ok' | 'failed' | 'busy' | 'idle';
  /** Status code of the latest failure, for its tag. */
  status?: number | null;
}

export interface RoutingScene {
  sources: SceneSourceState[];
  agents: SceneNode[];
  targets: SceneNode[];
  /** Newest first. */
  flows: SceneFlow[];
  stats: { requests: number; rerouted: number; failed: number; inflight: number };
  empty: null | 'no-source' | 'idle';
}

export interface SceneInput {
  now: number;
  gateway?: {
    running: boolean;
    /** Why reading the gateway failed, when it did. */
    readError?: string;
    /** Full records (main window) and the redacted feed (widgets) both fit. */
    decisions: RoutingFeedDecision[];
    requests: RoutingFeedRequest[];
  } | null;
  external?: ExternalLiveSnapshot | null;
}

const UNKNOWN_AGENT = 'Agent';

function parseTime(ts: string | null | undefined): number {
  const value = ts ? Date.parse(ts) : Number.NaN;
  return Number.isFinite(value) ? value : 0;
}

function isFresh(at: number, now: number): boolean {
  // Records stamped in the future (clock skew, fixtures) don't play either.
  const age = now - at;
  return age >= -2_000 && age < FLOW_LINGER_MS;
}

function hopOutcome(outcome: string): HopOutcome {
  return outcome === 'ok' || outcome === 'failed' || outcome === 'rejected' || outcome === 'skipped' ? outcome : 'failed';
}

function agentName(value: string | null | undefined): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : UNKNOWN_AGENT;
}

function flowsFromGateway(gateway: NonNullable<SceneInput['gateway']>, now: number): SceneFlow[] {
  const agentByRequest = new Map<string, string>();
  for (const record of gateway.requests) {
    const key = record.logicalRequestId ?? record.requestId;
    if (record.agent && !agentByRequest.has(key)) agentByRequest.set(key, record.agent);
  }
  const flows: SceneFlow[] = gateway.decisions.map((decision) => {
    const at = parseTime(decision.ts);
    const hops = decision.attempts.map((attempt) => ({ target: attempt.member, outcome: hopOutcome(attempt.outcome), status: attempt.status ?? null }));
    const answered = decision.chosen != null && hops.some((hop) => hop.outcome === 'ok');
    return {
      id: `tl:${decision.requestId}`,
      source: 'tokenledger',
      agent: agentName(agentByRequest.get(decision.requestId)),
      via: `${GROUP_PREFIX}${decision.group}`,
      hops,
      phase: answered ? 'routed' : 'failed',
      at,
      fresh: isFresh(at, now),
    };
  });
  // Direct (non-group) requests only reach the ledger once they finish, so
  // they are `done` or `failed`; group requests are already covered above.
  for (const record of gateway.requests) {
    if (record.group) continue;
    const at = parseTime(record.ts);
    flows.push({
      id: `tl:${record.requestId}`,
      source: 'tokenledger',
      agent: agentName(record.agent),
      via: record.requestedModel,
      hops: [{ target: `${record.provider}/${record.upstreamModel}`, outcome: record.ok ? 'ok' : 'failed', status: record.status || null }],
      phase: record.ok ? 'done' : 'failed',
      at,
      fresh: isFresh(at, now),
    });
  }
  return flows;
}

function flowsFromExternal(snapshot: ExternalLiveSnapshot, now: number): SceneFlow[] {
  const active = new Set(snapshot.active.map((request) => request.id));
  // Finished requests: the external gateway logs one line per attempt, so these are
  // complete and can be `done` (unlike a RouteDecision).
  const finished: SceneFlow[] = (snapshot.recent ?? []).filter((route) => !active.has(route.id)).map((route) => {
    const at = parseTime(route.ended);
    const hops = route.attempts.map((attempt) => ({
      target: route.model ? `${attempt.provider}/${route.model}` : attempt.provider,
      outcome: hopOutcome(attempt.outcome),
      status: attempt.status ?? null,
    }));
    return {
      id: `mp:${route.id}`,
      source: 'external',
      agent: agentName(route.agent),
      via: route.model ?? '外部网关',
      hops,
      phase: hops.some((hop) => hop.outcome === 'ok') ? 'done' : 'failed',
      at,
      fresh: isFresh(at, now),
    };
  });
  return finished.concat(snapshot.active.map((request) => {
    const started = parseTime(request.started);
    const at = started || (request.ms != null ? now - request.ms : now);
    const target = request.provider ? (request.model ? `${request.provider}/${request.model}` : request.provider) : null;
    return {
      id: `mp:${request.id}`,
      source: 'external',
      agent: agentName(request.agent),
      via: request.model ?? '外部网关',
      hops: target ? [{ target, outcome: 'pending' as const }] : [],
      phase: 'inflight' as const,
      at,
      waitingOn: request.phase || null,
      // In flight is live by definition, however long it has been running.
      fresh: true,
    };
  }));
}

function rank<T extends { id: string }>(items: Map<string, T & { at: number }>, limit: number): { kept: (T & { at: number })[]; folded: number } {
  // Stable: nodes from the same record keep the order they were tried in.
  const sorted = [...items.values()].sort((a, b) => b.at - a.at);
  return { kept: sorted.slice(0, limit), folded: Math.max(0, sorted.length - limit) };
}

export function buildRoutingScene(input: SceneInput): RoutingScene {
  const { now } = input;
  const sources: SceneSourceState[] = [];
  let flows: SceneFlow[] = [];

  if (input.gateway) {
    const { running, readError } = input.gateway;
    sources.push(readError
      ? { id: 'tokenledger', reachable: false, note: `读取网关路由记录失败：${readError}`, readError: true }
      : { id: 'tokenledger', reachable: running, note: running ? undefined : '网关未运行' });
    flows = flows.concat(flowsFromGateway(input.gateway, now));
  }
  if (input.external) {
    sources.push({ id: 'external', reachable: input.external.reachable, note: input.external.reachable ? undefined : '外部网关未运行' });
    // recent comes from the external gateway's own log and is returned even when its
    // gateway is down; in-flight requests only exist while it runs.
    flows = flows.concat(flowsFromExternal(input.external.reachable ? input.external : { ...input.external, active: [] }, now));
  }
  flows.sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));

  const agents = new Map<string, SceneNode & { at: number }>();
  const targets = new Map<string, SceneNode & { at: number }>();
  for (const flow of flows) {
    if (!agents.has(flow.agent)) agents.set(flow.agent, { id: flow.agent, label: flow.agent, at: flow.at, state: flow.phase === 'inflight' ? 'busy' : 'idle' });
    else if (flow.phase === 'inflight') agents.get(flow.agent)!.state = 'busy';
    for (const hop of flow.hops) {
      const existing = targets.get(hop.target);
      // Newest flow wins a node's state: flows are already newest first.
      if (existing) {
        if (hop.outcome === 'pending') existing.state = 'busy';
        continue;
      }
      targets.set(hop.target, {
        id: hop.target,
        label: hop.target,
        at: flow.at,
        state: hop.outcome === 'pending' ? 'busy' : hop.outcome === 'ok' ? 'ok' : hop.outcome === 'skipped' ? 'idle' : 'failed',
        status: hop.outcome === 'ok' || hop.outcome === 'pending' ? null : hop.status ?? null,
      });
    }
  }

  const strip = ({ at: _at, ...node }: SceneNode & { at: number }): SceneNode => node;
  const agentRank = rank(agents, MAX_AGENTS);
  const targetRank = rank(targets, MAX_TARGETS);
  const agentNodes = agentRank.kept.map(strip);
  const targetNodes = targetRank.kept.map(strip);
  if (agentRank.folded > 0) agentNodes.push({ id: '+agents', label: `+${agentRank.folded}`, more: agentRank.folded });
  if (targetRank.folded > 0) targetNodes.push({ id: '+targets', label: `+${targetRank.folded}`, more: targetRank.folded });

  const reachable = sources.some((source) => source.reachable);
  const stats = {
    requests: flows.filter((flow) => flow.phase !== 'inflight').length,
    rerouted: flows.filter((flow) => flow.hops.length > 1).length,
    failed: flows.filter((flow) => flow.phase === 'failed').length,
    inflight: flows.filter((flow) => flow.phase === 'inflight').length,
  };

  return {
    sources,
    agents: agentNodes,
    targets: targetNodes,
    flows,
    stats,
    empty: !reachable && flows.length === 0 ? 'no-source' : flows.length === 0 ? 'idle' : null,
  };
}

// ---------- layout: plain numbers, no DOM ----------

export interface Point { x: number; y: number }

export interface SceneLayout {
  width: number;
  height: number;
  hub: Point;
  agents: Map<string, Point>;
  targets: Map<string, Point>;
  nodeWidth: number;
  nodeHeight: number;
}

export interface LayoutOptions {
  width?: number;
  /** Vertical distance between node centres. */
  rowGap?: number;
  nodeWidth?: number;
  nodeHeight?: number;
  padding?: number;
}

function column(ids: string[], x: number, centerY: number, gap: number): Map<string, Point> {
  const out = new Map<string, Point>();
  const top = centerY - ((ids.length - 1) * gap) / 2;
  ids.forEach((id, index) => out.set(id, { x, y: top + index * gap }));
  return out;
}

/** Three columns: agents left, hub centre, targets right. */
export function layoutRoutingScene(scene: Pick<RoutingScene, 'agents' | 'targets'>, options: LayoutOptions = {}): SceneLayout {
  const width = options.width ?? 720;
  const rowGap = options.rowGap ?? 48;
  const nodeWidth = options.nodeWidth ?? 168;
  const nodeHeight = options.nodeHeight ?? 34;
  const padding = options.padding ?? 20;
  const rows = Math.max(1, scene.agents.length, scene.targets.length);
  const height = Math.max(120, padding * 2 + nodeHeight + (rows - 1) * rowGap);
  const centerY = height / 2;
  return {
    width,
    height,
    hub: { x: width / 2, y: centerY },
    agents: column(scene.agents.map((node) => node.id), padding + nodeWidth / 2, centerY, rowGap),
    targets: column(scene.targets.map((node) => node.id), width - padding - nodeWidth / 2, centerY, rowGap),
    nodeWidth,
    nodeHeight,
  };
}

/** A smooth horizontal S-curve between two points. */
export function wirePath(from: Point, to: Point): string {
  const mid = (from.x + to.x) / 2;
  return `M ${from.x} ${from.y} C ${mid} ${from.y}, ${mid} ${to.y}, ${to.x} ${to.y}`;
}

/** Truncates to `max` characters, keeping the tail (model names end in what differs). */
export function fitLabel(label: string, max: number): string {
  if (label.length <= max) return label;
  const head = Math.floor((max - 1) / 2);
  const tail = max - 1 - head;
  return `${label.slice(0, head)}…${label.slice(label.length - tail)}`;
}

/** One sentence for the caption under the stage (aria-live). */
export function describeFlow(flow: SceneFlow): string {
  const who = flow.agent === UNKNOWN_AGENT ? '请求' : `${flow.agent} 的请求`;
  if (flow.phase === 'inflight') {
    const target = flow.hops[0]?.target;
    const wait = flow.waitingOn === 'slot' ? '排队等空位' : flow.waitingOn === 'rpm' ? '等速率限制' : flow.waitingOn === 'upstream' ? '等上游回复' : '处理中';
    return target ? `${who}正发往 ${target}，${wait}` : `${who}正在选路，${wait}`;
  }
  const failedHops = flow.hops.filter((hop) => hop.outcome !== 'ok');
  const last = flow.hops[flow.hops.length - 1];
  const switched = failedHops.length > 0 && flow.phase !== 'failed'
    ? `${failedHops.map((hop) => `${hop.target}${hop.status ? ` 返回 ${hop.status}` : ' 失败'}`).join('，')}，已切换到 ${last.target}`
    : null;
  if (flow.phase === 'failed') {
    return flow.hops.length > 1
      ? `${who}（${flow.via}）依次试了 ${flow.hops.length} 个成员都没成功`
      : `${who}（${flow.via}）失败${last?.status ? `：${last.status}` : ''}`;
  }
  if (flow.phase === 'routed') return switched ? `${who}（${flow.via}）：${switched}，已接通` : `${who}（${flow.via}）已接通 ${last.target}`;
  return switched ? `${who}：${switched}，已完成` : `${who}由 ${last.target} 完成`;
}
