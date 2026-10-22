import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AnimatedNumber } from './AnimatedNumber';

const formatWhole = (value: number) => Math.round(value).toLocaleString('zh-CN');

describe('AnimatedNumber', () => {
  it('首次渲染直接显示真实值，不从 0 假装增长', () => {
    render(<AnimatedNumber value={994_500} format={formatWhole} />);
    expect(screen.getByText('994,500')).toBeInTheDocument();
  });

  it('目标值变化后最终落到新值', async () => {
    const { rerender } = render(<AnimatedNumber value={100} format={formatWhole} />);
    rerender(<AnimatedNumber value={250} format={formatWhole} />);
    await waitFor(() => expect(screen.getByText('250')).toBeInTheDocument(), { timeout: 2_000 });
  });
});
