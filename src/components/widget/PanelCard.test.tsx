import { describe, expect, it } from 'vitest';
import type { SceneFlow } from '../../features/gateway/routingScene';
import { describeRecentRoute, gatewayState, type TrayPanelStatus } from './PanelCard';

const STATUS: TrayPanelStatus = {
  gatewayEnabled: true,
  gatewayRunning: true,
  gatewayPort: 3421,
  gatewayFailed: false,
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
});
