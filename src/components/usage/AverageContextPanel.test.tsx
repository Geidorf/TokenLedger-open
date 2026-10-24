import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AverageContextPanel } from './AverageContextPanel';

const totals = {
  requests: 4,
  promptTokens: 40_000,
  systemBytes: 4_000,
  toolsBytes: 20_000,
  historyBytes: 12_000,
  toolResultsBytes: 4_000,
  attachmentsBytes: 0,
  messages: 30,
  toolResults: 2,
  attachments: 0,
};

describe('AverageContextPanel', () => {
  it('shows the per-request average with estimated tokens and the request count', () => {
    render(<AverageContextPanel totals={totals} />);
    const panel = screen.getByRole('region', { name: '平均 Context 构成' });
    // 平均输入 10,000 Token，工具定义占字节的一半。
    expect(panel).toHaveTextContent('工具定义≈5,00050%');
    expect(panel).toHaveTextContent('平均 7.5 条消息');
    expect(panel).toHaveTextContent('基于 4 次经网关的请求');
    expect(panel).not.toHaveTextContent('附件');
    expect(screen.getByRole('img')).toHaveAttribute('aria-label', expect.stringContaining('工具定义 50%'));
  });

  it('renders nothing without measured requests', () => {
    const { container, rerender } = render(<AverageContextPanel totals={undefined} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<AverageContextPanel totals={{ ...totals, requests: 0 }} />);
    expect(container).toBeEmptyDOMElement();
  });
});
