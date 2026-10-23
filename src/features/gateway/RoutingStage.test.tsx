import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { hopTiming, RoutingStage, RoutingStageEmpty } from './RoutingStage';
import { buildRoutingScene } from './routingScene';
import type { RouteDecision } from './types';

const NOW = Date.parse('2026-10-23T14:00:00Z');

const decision: RouteDecision = {
  ts: new Date(NOW - 1_000).toISOString(),
  requestId: 'r1',
  group: 'coding',
  reason: 'failover',
  detail: '按顺序',
  chosen: 'deepseek/deepseek-chat',
  attempts: [
    { member: 'openai/gpt-5', outcome: 'failed', status: 429 },
    { member: 'deepseek/deepseek-chat', outcome: 'ok', status: 200 },
  ],
};

describe('RoutingStage', () => {
  it('新鲜的失败切换按顺序播放每一跳，失败成员带状态码', () => {
    const scene = buildRoutingScene({ now: NOW, gateway: { running: true, decisions: [decision], requests: [] } });
    const { container } = render(<RoutingStage scene={scene} />);
    const packets = [...container.querySelectorAll('.rs-sky .rs-packet')] as SVGPathElement[];
    // agent → hub, then hub → failed member, then hub → the member it switched to
    expect(packets.map((packet) => packet.getAttribute('class'))).toEqual(['rs-packet', 'rs-packet is-failed', 'rs-packet is-ok']);
    const delays = packets.map((packet) => parseFloat(packet.style.animationDelay));
    expect(delays[0]).toBe(0);
    expect(delays[1]).toBeGreaterThan(delays[0]);
    expect(delays[2]).toBeGreaterThan(delays[1]);
    expect(container.querySelector('.rs-tag text')?.textContent).toBe('429');
    expect(screen.getByText(/已切换到 deepseek\/deepseek-chat，已接通/)).toBeInTheDocument();
  });

  it('过期记录只留下点亮状态与「最近」说明，不再播放', () => {
    const scene = buildRoutingScene({ now: NOW + 60_000, gateway: { running: true, decisions: [decision], requests: [] } });
    const { container } = render(<RoutingStage scene={scene} />);
    expect(container.querySelectorAll('.rs-packet')).toHaveLength(0);
    expect(container.querySelectorAll('.rs-wire.is-live')).toHaveLength(0);
    expect(screen.getByText(/^最近：/)).toBeInTheDocument();
  });

  it('在途请求让连线流动、网关脉冲', () => {
    const scene = buildRoutingScene({ now: NOW, external: { reachable: true, active: [{ id: 'm1', agent: 'claude', model: 'sonnet', provider: 'anthropic', ms: 300, phase: 'upstream' }] } });
    const { container } = render(<RoutingStage scene={scene} variant="compact" />);
    expect(container.querySelectorAll('.rs-wire.is-live')).toHaveLength(2);
    expect(container.querySelector('.rs-hub.is-busy')).not.toBeNull();
    expect(container.querySelector('.rs-held')).not.toBeNull();
  });

  it('成员超过上限时，折叠进 +N 的那一跳仍画到折叠节点，路径以真实结果收尾', () => {
    const members = Array.from({ length: 7 }, (_, index) => `p/m${index}`);
    const long: RouteDecision = {
      ...decision,
      chosen: members[6],
      attempts: members.map((member, index) => ({ member, outcome: index === 6 ? 'ok' : 'failed', status: index === 6 ? 200 : 503 })),
    };
    const scene = buildRoutingScene({ now: NOW, gateway: { running: true, decisions: [long], requests: [] } });
    const { container } = render(<RoutingStage scene={scene} />);
    const packets = [...container.querySelectorAll('.rs-sky .rs-packet')];
    expect(packets).toHaveLength(8);
    expect(packets[packets.length - 1].getAttribute('class')).toBe('rs-packet is-ok');
  });

  it('折叠进 +N 的 Agent 的请求从折叠节点出发，不会消失', () => {
    const decisions: RouteDecision[] = Array.from({ length: 6 }, (_, index) => ({ ...decision, requestId: `r${index}`, ts: new Date(NOW - 1_000 - index * 100).toISOString() }));
    const requests = decisions.map((item, index) => ({
      ts: item.ts, requestId: `a${index}`, logicalRequestId: item.requestId, agent: `agent-${index}`, endpoint: '/v1/responses', provider: 'deepseek',
      requestedModel: 'group/coding', upstreamModel: 'deepseek-chat', wire: 'chat', stream: true, status: 200, ok: true,
      input: 1, output: 1, cacheRead: 0, cacheWrite: 0, latencyMs: 1, group: 'coding',
    }));
    const scene = buildRoutingScene({ now: NOW, gateway: { running: true, decisions, requests } });
    expect(scene.agents[scene.agents.length - 1]).toMatchObject({ id: '+agents', more: 2 });
    const { container } = render(<RoutingStage scene={scene} />);
    expect(container.querySelectorAll('.rs-sky .rs-flow')).toHaveLength(6);
  });

  it('长链失败切换压缩节奏，整段回放在 4 秒内播完', () => {
    expect(hopTiming(1).step).toBeCloseTo(0.95);
    const long = hopTiming(16);
    expect(long.total).toBeLessThanOrEqual(4);
    expect(long.run).toBeLessThan(long.step);
  });

  it('读取失败与网关停止分开说明', () => {
    const scene = buildRoutingScene({ now: NOW, gateway: { running: false, decisions: [], requests: [], readError: '权限不足' } });
    render(<RoutingStageEmpty scene={scene} />);
    expect(screen.getByRole('status')).toHaveTextContent('读取实时路由数据失败');
    expect(screen.getByRole('status')).toHaveTextContent('权限不足');
    expect(screen.getByRole('status')).not.toHaveTextContent('网关未运行');
  });

  it('空态说明来源为什么不可达', () => {
    const scene = buildRoutingScene({ now: NOW, gateway: { running: false, decisions: [], requests: [] } });
    render(<RoutingStageEmpty scene={scene} />);
    expect(screen.getByRole('status')).toHaveTextContent('暂无实时路由数据');
    expect(screen.getByRole('status')).toHaveTextContent('网关未运行');
  });
});
