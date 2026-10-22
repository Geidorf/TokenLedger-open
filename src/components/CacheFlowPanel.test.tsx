import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Summary } from '../types';
import { CacheFlowPanel } from './CacheFlowPanel';

function summary(overrides: Partial<Summary> = {}): Summary {
  return {
    totalTokens: 400_000,
    inputTokens: 300_000,
    outputTokens: 100_000,
    cachedTokens: 0,
    totalCost: 1,
    totalRequests: 10,
    avgTokensPerReq: 40_000,
    ...overrides,
  };
}

describe('CacheFlowPanel honesty contract', () => {
  it('shows reuse rate and split flow when the source provides read/write split', () => {
    render(
      <CacheFlowPanel
        summary={summary({
          cachedTokens: 200_000,
          cacheReadTokens: 160_000,
          cacheWriteTokens: 40_000,
          cacheSavedUsd: 20.5,
          cacheSavings: { readSavedUsd: 20.5, writePremiumUsd: 0.5, netSavedUsd: 20, fallbackPricedReadTokens: 0, fallbackPricedWriteTokens: 0, priceBasis: 'local-prices' },
        })}
      />,
    );
    expect(screen.getByText('复用率 34.8%')).toBeInTheDocument();
    expect(screen.getByText(/缓存命中读取/)).toBeInTheDocument();
    expect(screen.getByText(/未命中全价输入/)).toBeInTheDocument();
    expect(screen.getByText(/≈\$20.00/)).toBeInTheDocument();
    expect(screen.queryByText('不可得')).not.toBeInTheDocument();
    // T10.162：净节省为主值，读取节省与写入溢价分列。
    expect(screen.getByText('缓存净节省（当前范围）')).toBeInTheDocument();
    // U-102：口径与「按价格表估算，非账单」收进 ⓘ，经 aria-describedby 可读。
    expect(screen.getByRole('button', { name: '缓存口径说明' })).toHaveAccessibleDescription(/三项均按价格表估算，非账单/);
    expect(document.body.textContent).not.toMatch(/预估节省|供应商账单/);
  });

  it('degrades to a combined cache label instead of claiming hit rate when split is unknown', () => {
    render(
      <CacheFlowPanel
        summary={summary({ cachedTokens: 200_000, cacheSavedUsd: 12 })}
      />,
    );
    expect(screen.queryByText(/^复用率 \d/)).not.toBeInTheDocument();
    expect(screen.getByRole('group', { name: '缓存合计，读写未拆分' })).toBeInTheDocument();
    expect(screen.getByText('仅有缓存合计')).toBeVisible();
    const explanation = screen.getByText(/缺少可信的缓存读写拆分/);
    expect(explanation).not.toBeVisible();
    fireEvent.click(screen.getByText('为什么无法计算复用与节省？'));
    expect(explanation).toBeVisible();
    fireEvent.click(screen.getByText('为什么无法计算复用与节省？'));
    expect(explanation).not.toBeVisible();
    expect(screen.queryByText(/≈\$12\.00/)).not.toBeInTheDocument();
    expect(explanation).toHaveTextContent('缺少可信的缓存读写拆分，无法计算流向、复用率或缓存净节省。');
  });

  it('rejects an inconsistent read/write split and shows only the combined total', () => {
    render(
      <CacheFlowPanel
        summary={summary({
          cachedTokens: 200_000,
          cacheReadTokens: 180_000,
          cacheWriteTokens: 40_000,
        })}
      />,
    );
    expect(screen.queryByText(/复用率 \d/)).not.toBeInTheDocument();
    expect(screen.getByText('仅有缓存合计')).toBeInTheDocument();
  });

  it('renders 不可得 instead of $0.00 when the savings estimate is missing', () => {
    render(
      <CacheFlowPanel
        summary={summary({
          cachedTokens: 100_000,
          cacheReadTokens: 80_000,
          cacheWriteTokens: 20_000,
        })}
      />,
    );
    expect(screen.getByText('不可得')).toBeInTheDocument();
    expect(screen.queryByText(/\$0\.00/)).not.toBeInTheDocument();
    expect(screen.getByText('缺少可用价格估算，不显示 0')).toBeInTheDocument();
  });

  it('hides the panel entirely when there is neither input nor cache', () => {
    const { container } = render(
      <CacheFlowPanel summary={summary({ inputTokens: 0, outputTokens: 0, totalTokens: 0 })} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
