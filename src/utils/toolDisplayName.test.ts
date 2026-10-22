import { describe, expect, it } from 'vitest';
import fixture from '../../fixtures/tool-display-names-v1/names.json';
import { describeToolDistribution } from '../components/DonutPanel';
import { buildTools } from '../components/widget/cardModel';
import type { ToolStat } from '../types';
import { toolDisplayName } from './toolDisplayName';

/** 与 src-tauri/src/wallpaper.rs 的 tool_display_name_tests 逐条相同。改一处必须改另一处。 */
const GOLDEN: Array<[string, string]> = [
  ['opencode', 'OpenCode'],
  ['OpenCode', 'OpenCode'],
  ['workbuddy', 'WorkBuddy'],
  ['deepseek', 'DeepSeek'],
  ['deepseekgui', 'DeepSeek'],
  ['dsh', 'DeepSeek'],
  ['qclaw', 'QClaw'],
  ['minimax', 'MiniMax'],
  ['zcode', 'ZCode'],
  ['kimidesktop', 'Kimi'],
  ['KimiDesktop', 'Kimi'],
  ['mavis', 'Marvis'],
  ['marvis', 'Marvis'],
  ['codex', 'Codex'],
  [' codex ', 'Codex'],
  ['CODEX', 'Codex'],
  ['claude', 'Claude'],
  ['reasonix', 'ReasoniX'],
  ['antigravity', 'Antigravity'],
  ['gemini', 'Gemini'],
  ['hermes', 'Hermes'],
  ['pi', 'Pi'],
  ['grok', 'Grok'],
  ['kilo', 'Kilo'],
  ['kimi', 'Kimi'],
  ['trae', 'Trae'],
  ['', '未命名工具'],
  ['   ', '未命名工具'],
  ['cursor', 'Cursor'],
  ['未来工具', '未来工具'],
  ['\uFEFFcodex', 'Codex'],
  ['\u0085codex', '\u0085codex'],
];

function tool(name: string, input: number): ToolStat {
  return { name, input, output: 0, cached: 0, total: input, cost: 0, requests: 1 };
}

describe('toolDisplayName（看板 / 挂件 / 壁纸共用）', () => {
  it('黄金用例与夹具逐条一致', () => {
    for (const [id, name] of GOLDEN) {
      expect(toolDisplayName(id), id).toBe(name);
    }
  });

  it('夹具里的每一条名字和别名都走这一个函数', () => {
    const names: Record<string, string> = fixture.names;
    const aliases: Record<string, string> = fixture.aliases;
    for (const [id, name] of Object.entries(names)) {
      expect(toolDisplayName(id)).toBe(name);
      expect(aliases[id]).toBeUndefined();
    }
    for (const [alias, canonical] of Object.entries(aliases)) {
      expect(names[canonical], alias).toBeTruthy();
      expect(toolDisplayName(alias)).toBe(names[canonical]);
    }
    expect(fixture.emptyLabel).toBe('未命名工具');
  });

  it('挂件构成条与看板分布摘要用同一中文名', () => {
    const tools = buildTools({
      a: tool('deepseekgui', 2),
      b: tool('opencode', 1),
    }, 'dark');
    expect(tools?.items.map((item) => [item.id, item.name])).toEqual([
      ['deepseekgui', 'DeepSeek'],
      ['opencode', 'OpenCode'],
    ]);
    const summary = describeToolDistribution([tool('opencode', 1), tool('kimidesktop', 1)], false);
    expect(summary).toContain('OpenCode');
    expect(summary).toContain('Kimi');
    expect(summary).not.toContain('opencode');
    expect(summary).not.toContain('kimidesktop');
  });
});
