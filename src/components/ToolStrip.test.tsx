import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ToolStat } from '../types';
import { ToolStrip } from './ToolStrip';

function tool(name: string): ToolStat {
  return { name, input: 10, output: 5, cached: 0, total: 15, cost: 0, requests: 1 };
}

describe('ToolStrip 工具显示名', () => {
  it('芯片和读屏用共用显示名，估算标记仍按原始 id', () => {
    render(<ToolStrip activeTools={[tool('opencode'), tool('kimidesktop'), tool('antigravity')]} showTotalTokens={false} />);
    expect(screen.getByRole('button', { name: '打开 OpenCode 专属看板' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '打开 Kimi 专属看板' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '打开 Antigravity 专属看板' })).toHaveTextContent('≈');
    expect(screen.queryByRole('button', { name: /opencode|kimidesktop|antigravity/ })).not.toBeInTheDocument();
  });
});
