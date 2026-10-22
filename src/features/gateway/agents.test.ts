import { invoke } from '@tauri-apps/api/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { jsonAgent, MANUAL_AGENTS, PENDING_AGENTS, SUPPORTED_AGENTS } from './agents';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue(null) }));

describe('jsonAgent', () => {
  beforeEach(() => vi.clearAllMocks());

  it('把检查、预览、写入、恢复转给 gateway_agent_* 并带上 Agent id', async () => {
    const agent = jsonAgent('demo', 'Demo', null, 'DM');
    await agent.inspect();
    await agent.preview('group/coding');
    await agent.apply('group/coding', 'v1');
    await agent.restore(true);
    expect(vi.mocked(invoke).mock.calls).toEqual([
      ['gateway_agent_inspect', { agent: 'demo' }],
      ['gateway_agent_preview', { agent: 'demo', model: 'group/coding' }],
      ['gateway_agent_apply', { input: { agent: 'demo', model: 'group/coding', expectedVersion: 'v1' } }],
      ['gateway_agent_restore', { agent: 'demo', force: true }],
    ]);
  });
});

describe('SUPPORTED_AGENTS', () => {
  it('首批 JSON Agent 已从待支持列表移出', () => {
    const supported = SUPPORTED_AGENTS.map((agent) => agent.id);
    expect(supported).toEqual(expect.arrayContaining(['codex', 'opencode', 'crush', 'pi', 'claude-code', 'gemini-cli']));
    for (const pending of PENDING_AGENTS) expect(supported).not.toContain(pending.id);
  });

  it('Zed 自动写入，Cline 改为手动配置且不再列为即将支持', () => {
    expect(SUPPORTED_AGENTS.map((agent) => agent.id)).toContain('zed');
    const cline = MANUAL_AGENTS.find((agent) => agent.id === 'cline');
    expect(cline?.fields.map((field) => field.value.kind)).toEqual(['text', 'baseUrl', 'token', 'model']);
    expect(PENDING_AGENTS.map((agent) => agent.id)).not.toContain('cline');
    expect(SUPPORTED_AGENTS.map((agent) => agent.id)).not.toContain('cline');
  });

  it('MiniMax Code 自动写入，Claude Desktop 手动配置，两者都不在即将支持里', () => {
    expect(SUPPORTED_AGENTS.map((agent) => agent.id)).toContain('minimax-code');
    const desktop = MANUAL_AGENTS.find((agent) => agent.id === 'claude-desktop');
    expect(desktop?.fields.map((field) => field.value.kind)).toEqual(['text', 'gatewayRoot', 'token', 'text', 'model']);
    expect(desktop?.steps?.[0]).toContain('Enable Developer Mode');
    expect(desktop?.notes?.join('')).toContain('订阅账号');
    const pending = PENDING_AGENTS.map((agent) => agent.id);
    expect(pending).not.toContain('claude-desktop');
    expect(pending).not.toContain('minimax-code');
    const ids = [...SUPPORTED_AGENTS, ...MANUAL_AGENTS, ...PENDING_AGENTS].map((agent) => agent.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('第二批 Kimi CLI、Hermes、Goose、Oh My Pi 走通用写入器，id 不重复', () => {
    const supported = SUPPORTED_AGENTS.map((agent) => agent.id);
    expect(supported).toEqual(expect.arrayContaining(['kimi-cli', 'hermes', 'goose', 'omp']));
    const ids = [...supported, ...PENDING_AGENTS.map((agent) => agent.id)];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('oh-my-opencode 改由通用写入器接入，不再列为即将支持', async () => {
    const omo = SUPPORTED_AGENTS.find((agent) => agent.id === 'oh-my-opencode');
    expect(omo).toMatchObject({ name: 'oh-my-opencode', icon: 'opencode', monogram: 'OM' });
    expect(PENDING_AGENTS.map((agent) => agent.id)).not.toContain('oh-my-opencode');
    vi.mocked(invoke).mockClear();
    await omo?.preview('group/coding');
    expect(vi.mocked(invoke)).toHaveBeenCalledWith('gateway_agent_preview', { agent: 'oh-my-opencode', model: 'group/coding' });
  });
});
