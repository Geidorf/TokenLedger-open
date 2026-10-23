import { describe, expect, it } from 'vitest';
import { buildRoutingScene, describeFlow, FLOW_LINGER_MS, fitLabel, layoutRoutingScene, MAX_TARGETS } from './routingScene';
import type { LedgerRecord, RouteDecision } from './types';

const NOW = Date.parse('2026-10-23T14:00:00Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const failover: RouteDecision = {
  ts: ago(2_000),
  requestId: 'r1',
  group: 'coding',
  session: 's1',
  reason: 'failover',
  detail: '按顺序',
  chosen: 'deepseek/deepseek-chat',
  attempts: [
    { member: 'openai/gpt-5', outcome: 'failed', status: 429 },
    { member: 'deepseek/deepseek-chat', outcome: 'ok', status: 200 },
  ],
};

const ledger = (patch: Partial<LedgerRecord>): LedgerRecord => ({
  ts: ago(3_000), requestId: 'x', endpoint: '/v1/responses', provider: 'openai', requestedModel: 'openai/gpt-5', upstreamModel: 'gpt-5',
  wire: 'responses', stream: true, status: 200, ok: true, input: 1, output: 1, cacheRead: 0, cacheWrite: 0, latencyMs: 10, ...patch,
});

describe('buildRoutingScene', () => {
  it('没有任何可达数据源时给出 no-source 空态，不编造流量', () => {
    const scene = buildRoutingScene({ now: NOW, gateway: { running: false, decisions: [], requests: [] } });
    expect(scene.empty).toBe('no-source');
    expect(scene.flows).toEqual([]);
    expect(scene.sources).toEqual([{ id: 'tokenledger', reachable: false, note: '网关未运行' }]);
  });

  it('网关在线但没有请求时是 idle 空态', () => {
    expect(buildRoutingScene({ now: NOW, gateway: { running: true, decisions: [], requests: [] } }).empty).toBe('idle');
  });

  it('失败切换：按尝试顺序保留每一跳，接通后是 routed 而不是 done', () => {
    const scene = buildRoutingScene({
      now: NOW,
      gateway: { running: true, decisions: [failover], requests: [ledger({ requestId: 'a1', logicalRequestId: 'r1', agent: 'codex', group: 'coding' })] },
    });
    expect(scene.flows).toHaveLength(1);
    const [flow] = scene.flows;
    expect(flow.phase).toBe('routed');
    expect(flow.agent).toBe('codex');
    expect(flow.fresh).toBe(true);
    expect(flow.hops.map((hop) => [hop.target, hop.outcome])).toEqual([['openai/gpt-5', 'failed'], ['deepseek/deepseek-chat', 'ok']]);
    expect(scene.targets.map((node) => [node.id, node.state, node.status])).toEqual([
      ['openai/gpt-5', 'failed', 429],
      ['deepseek/deepseek-chat', 'ok', null],
    ]);
    expect(scene.stats).toEqual({ requests: 1, rerouted: 1, failed: 0, inflight: 0 });
    expect(describeFlow(flow)).toBe('codex 的请求（group/coding）：openai/gpt-5 返回 429，已切换到 deepseek/deepseek-chat，已接通');
  });

  it('没有成员接通时是 failed', () => {
    const decision: RouteDecision = { ...failover, chosen: null, attempts: [{ member: 'openai/gpt-5', outcome: 'failed', status: 500 }, { member: 'deepseek/deepseek-chat', outcome: 'rejected', status: 400 }] };
    const scene = buildRoutingScene({ now: NOW, gateway: { running: true, decisions: [decision], requests: [] } });
    expect(scene.flows[0].phase).toBe('failed');
    expect(scene.stats.failed).toBe(1);
  });

  it('直连请求只来自已结束的账本记录，组请求的账本记录不重复画', () => {
    const scene = buildRoutingScene({
      now: NOW,
      gateway: { running: true, decisions: [failover], requests: [ledger({ requestId: 'd1', agent: 'claude' }), ledger({ requestId: 'a1', logicalRequestId: 'r1', group: 'coding' })] },
    });
    expect(scene.flows.map((flow) => [flow.id, flow.phase])).toEqual([['tl:r1', 'routed'], ['tl:d1', 'done']]);
  });

  it('超过停留时长或时间在未来的记录不再播放', () => {
    const old = { ...failover, ts: ago(FLOW_LINGER_MS + 1) };
    const future = { ...failover, requestId: 'r2', ts: new Date(NOW + 60_000).toISOString() };
    const scene = buildRoutingScene({ now: NOW, gateway: { running: true, decisions: [old, future], requests: [] } });
    expect(scene.flows.every((flow) => !flow.fresh)).toBe(true);
  });

  it('外部网关在途请求是 inflight，未运行时只记来源不可达', () => {
    const scene = buildRoutingScene({
      now: NOW,
      external: { reachable: true, active: [{ id: 'm1', agent: 'claude', model: 'sonnet', provider: 'anthropic', ms: 800, phase: 'upstream' }, { id: 'm2', agent: 'codex', ms: 100, phase: 'slot' }] },
    });
    expect(scene.flows.map((flow) => [flow.id, flow.phase, flow.hops.length])).toEqual([['mp:m2', 'inflight', 0], ['mp:m1', 'inflight', 1]]);
    expect(scene.stats.inflight).toBe(2);
    expect(scene.targets[0]).toMatchObject({ id: 'anthropic/sonnet', state: 'busy' });
    expect(describeFlow(scene.flows[0])).toBe('codex 的请求正在选路，排队等空位');

    const down = buildRoutingScene({ now: NOW, external: { reachable: false, active: [] } });
    expect(down.empty).toBe('no-source');
    expect(down.sources[0]).toMatchObject({ id: 'external', reachable: false });
  });

  it('上游超过上限时折叠成 +N', () => {
    const decisions: RouteDecision[] = Array.from({ length: MAX_TARGETS + 2 }, (_, index) => ({
      ...failover, requestId: `r${index}`, ts: ago(index * 100), chosen: `p/m${index}`, attempts: [{ member: `p/m${index}`, outcome: 'ok', status: 200 }],
    }));
    const scene = buildRoutingScene({ now: NOW, gateway: { running: true, decisions, requests: [] } });
    expect(scene.targets).toHaveLength(MAX_TARGETS + 1);
    expect(scene.targets[scene.targets.length - 1]).toMatchObject({ id: '+targets', more: 2 });
  });
});

describe('layout', () => {
  it('三列布局：Agent 在左、网关居中、上游在右，行距均匀', () => {
    const layout = layoutRoutingScene({ agents: [{ id: 'a', label: 'a' }], targets: [{ id: 'x', label: 'x' }, { id: 'y', label: 'y' }] }, { width: 600, rowGap: 40, nodeWidth: 100, padding: 10 });
    expect(layout.hub.x).toBe(300);
    expect(layout.agents.get('a')).toEqual({ x: 60, y: layout.hub.y });
    expect(layout.targets.get('y')!.y - layout.targets.get('x')!.y).toBe(40);
    expect(layout.targets.get('x')!.x).toBe(540);
  });

  it('长标签保留首尾', () => {
    expect(fitLabel('openrouter/anthropic/claude-sonnet-4.5', 16)).toBe('openrou…nnet-4.5');
    expect(fitLabel('short', 16)).toBe('short');
  });
});

describe('外部网关最近完成的请求', () => {
  it('已结束的请求按尝试画出切换，是 done；外部网关未运行时 recent 仍可显示', () => {
    const recent = [{ id: 'q1', agent: 'claude', model: 'sonnet', ended: ago(1_000), attempts: [{ provider: 'acct-a', outcome: 'failed', status: 529 }, { provider: 'acct-b', outcome: 'ok', status: 200 }] }];
    const scene = buildRoutingScene({ now: NOW, external: { reachable: false, active: [], recent } });
    expect(scene.empty).toBeNull();
    expect(scene.flows[0]).toMatchObject({ id: 'mp:q1', phase: 'done', fresh: true });
    expect(scene.flows[0].hops.map((hop) => hop.target)).toEqual(['acct-a/sonnet', 'acct-b/sonnet']);
    expect(describeFlow(scene.flows[0])).toBe('claude 的请求：acct-a/sonnet 返回 529，已切换到 acct-b/sonnet，已完成');
  });
});
