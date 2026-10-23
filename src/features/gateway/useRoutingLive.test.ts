import { describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { buildRoutingScene } from './routingScene';
import { readExternalGateway } from './useRoutingLive';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

describe('readExternalGateway', () => {
  it('读外部本机网关的实时快照，在途请求的数字 id 转成场景用的字符串', async () => {
    const now = Date.parse('2026-10-23T13:00:05Z');
    vi.mocked(invoke).mockResolvedValueOnce({
      reachable: true, port: 3425, requests: 1, waiting: 0, tools: 0,
      active: [{ id: 7, agent: 'claude', model: '', provider: '', started: '2026-10-23T13:00:04Z', ms: 1000, phase: 'slot' }],
      recent: [{ id: '9', agent: 'claude', model: 'm', ended: '2026-10-23T13:00:03Z', attempts: [{ provider: 'a', outcome: 'failed', status: 529 }, { provider: 'b', outcome: 'ok' }] }],
    });
    const snapshot = await readExternalGateway();
    expect(vi.mocked(invoke)).toHaveBeenCalledWith('peer_live_snapshot', {});
    expect(snapshot.active[0].id).toBe('7');
    const scene = buildRoutingScene({ now, external: snapshot });
    // 路由决定前没有模型与上游：在途流不画上游，经由写「外部网关」而不是空串。
    expect(scene.flows.map((flow) => [flow.id, flow.phase, flow.via])).toEqual([['ext:7', 'inflight', '外部网关'], ['ext:9', 'done', 'm']]);
    expect(scene.flows[0].waitingOn).toBe('slot');
  });

  it('外部网关没运行不是错误：来源不可达，最近完成的记录照常可画', async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ reachable: false, port: 3425, requests: 0, waiting: 0, tools: 0, active: [], recent: [] });
    const snapshot = await readExternalGateway();
    const scene = buildRoutingScene({ now: Date.now(), external: snapshot });
    expect(scene.sources).toEqual([expect.objectContaining({ id: 'external', reachable: false })]);
    expect(scene.empty).toBe('no-source');
  });
});
