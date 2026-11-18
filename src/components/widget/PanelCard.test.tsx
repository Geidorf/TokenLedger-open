import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { RoutingScene, SceneFlow } from '../../features/gateway/routingScene';
import type { CardModel } from './cardModel';
import { describeRecentRoute, gatewayState, PanelCard, type PanelControls, type TrayPanelStatus } from './PanelCard';

const STATUS: TrayPanelStatus = {
  gatewayEnabled: true,
  gatewayRunning: true,
  gatewayPort: 3421,
  gatewayFailed: false,
  gatewayNoProvider: false,
  syncPaused: false,
  scanPaused: false,
  scanIntervalSecs: 900,
};

function flow(overrides: Partial<SceneFlow>): SceneFlow {
  return { id: 'f', source: 'tokenledger', agent: 'codex', via: 'group/coding', hops: [], phase: 'done', at: 0, fresh: true, ...overrides };
}

describe('PanelCard', () => {
  it('网关状态只说开关与是否在监听，不带地址或错误原文', () => {
    expect(gatewayState(null)).toEqual({ text: '—', tone: 'unknown' });
    expect(gatewayState(STATUS)).toEqual({ text: '运行中 · :3421', tone: 'ok' });
    expect(gatewayState({ ...STATUS, gatewayEnabled: false, gatewayRunning: false })).toEqual({ text: '已关闭', tone: 'off' });
    expect(gatewayState({ ...STATUS, gatewayRunning: false, gatewayFailed: true }).text).toBe('未运行，去主窗口查看');
    expect(gatewayState({ ...STATUS, gatewayRunning: false, gatewayNoProvider: true }).text).toBe('没有可用的供应商，去主窗口添加');
    expect(gatewayState({ ...STATUS, gatewayRunning: false }).text).toBe('正在启动…');
    expect(gatewayState({ ...STATUS, gatewayRunning: false }).text).toBe('正在启动…');
  });

  it('最近路由把失败切换写成「✕ →」，失败与进行中各有自己的状态', () => {
    expect(describeRecentRoute(flow({
      hops: [{ target: 'openai/gpt-5', outcome: 'failed', status: 429 }, { target: 'deepseek/chat', outcome: 'ok' }],
    }))).toEqual({ path: 'codex → openai/gpt-5 ✕ → deepseek/chat', outcome: 'ok' });
    expect(describeRecentRoute(flow({ phase: 'failed', hops: [{ target: 'relay', outcome: 'failed', status: 529 }] })))
      .toEqual({ path: 'codex → relay ✕', outcome: 'failed' });
    expect(describeRecentRoute(flow({ phase: 'inflight', hops: [] }))).toEqual({ path: 'codex → 选路中', outcome: 'pending' });
  });

  const MODEL: CardModel = {
    cost: '$1.20',
    tokens: '12.3K',
    records: 5,
    change: { text: '+10%', tone: 'up' },
    quota: { kind: 'ready', items: [] },
    status: { text: '刚刚', tone: 'ok' },
  } as unknown as CardModel;

  const makeControls = (gatewayEnabled: boolean): PanelControls => ({
    status: { ...STATUS, gatewayEnabled, gatewayRunning: gatewayEnabled },
    pending: null,
    error: '',
    onToggle: vi.fn(),
    onCloseGateway: vi.fn(),
  });

  const EMPTY_SCENE: RoutingScene = {
    empty: 'idle',
    sources: [],
    agents: [],
    targets: [],
    flows: [],
    stats: { requests: 0, rerouted: 0, failed: 0, inflight: 0 },
  };

  it('网关关闭且无实时路由时隐藏网关区块与网关开关，仅保留同步与扫描开关', () => {
    const { container } = render(
      <PanelCard model={MODEL} now={1_000} scene={EMPTY_SCENE} loaded controls={makeControls(false)} />,
    );
    expect(container.querySelector('.wl-panel-gateway')).toBeNull();
    expect(screen.queryByRole('switch', { name: '网关' })).toBeNull();
    expect(screen.getByRole('switch', { name: '后台同步' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: '后台扫描' })).toBeInTheDocument();
  });

  it('网关开启或存在非空实时路由时完整保留网关区块与三个开关', () => {
    const { container, rerender } = render(
      <PanelCard model={MODEL} now={1_000} scene={EMPTY_SCENE} loaded controls={makeControls(true)} />,
    );
    expect(container.querySelector('.wl-panel-gateway')).not.toBeNull();
    expect(screen.getByRole('switch', { name: '网关' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: '后台同步' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: '后台扫描' })).toBeInTheDocument();

    const activeScene: RoutingScene = {
      ...EMPTY_SCENE,
      empty: null,
      agents: [{ id: 'codex', label: 'codex', state: 'ok' }],
      targets: [{ id: 'anthropic/claude', label: 'anthropic/claude', state: 'ok' }],
      flows: [flow({ id: 'f1', hops: [{ target: 'anthropic/claude', outcome: 'ok' }] })],
      stats: { requests: 1, rerouted: 0, failed: 0, inflight: 0 },
    };
    rerender(<PanelCard model={MODEL} now={1_000} scene={activeScene} loaded controls={makeControls(false)} />);
    expect(container.querySelector('.wl-panel-gateway')).not.toBeNull();
    expect(screen.getByRole('switch', { name: '网关' })).toBeInTheDocument();
  });
});
