import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { BusyState } from '../../types';
import { PricingSection } from './PricingSection';

function busyState(prices = false): BusyState {
  return {
    scan: false,
    sync: false,
    wallpaper: false,
    auth: false,
    config: false,
    settings: false,
    prices,
    db: false,
  };
}

describe('PricingSection', () => {
  it('只在价格编辑器展开后声明已挂载的控制目标', () => {
    render(
      <PricingSection
        pricesText={JSON.stringify({ 'gpt-5-codex': { input: 1, output: 2 } })}
        pricesError=""
        pricesLoadError=""
        pricesLoading={false}
        pricesDirty={false}
        busy={busyState()}
        onPricesChange={vi.fn()}
        onReloadPrices={vi.fn()}
        onSavePrices={vi.fn()}
        onResetPrices={vi.fn()}
        onImportModelsDevPrice={vi.fn(async () => true)}
      />,
    );

    const trigger = screen.getByRole('button', { name: /1 个模型/ });
    expect(trigger).not.toHaveAttribute('aria-controls');

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-controls', 'settings-pricing-editor');
    expect(document.getElementById('settings-pricing-editor')).toBeInTheDocument();
  });

  it('折叠态只概览模型和待核价，展开后显示计价单位', () => {
    render(
      <PricingSection
        pricesText={JSON.stringify({
          'gpt-5-codex': {
            input: 1,
            output: 2,
            _meta: { status: 'auto_discovered', fallback_key: 'default' },
          },
        })}
        pricesError=""
        pricesLoadError=""
        pricesLoading={false}
        pricesDirty={false}
        busy={busyState()}
        onPricesChange={vi.fn()}
        onReloadPrices={vi.fn()}
        onSavePrices={vi.fn()}
        onResetPrices={vi.fn()}
        onImportModelsDevPrice={vi.fn(async () => true)}
      />,
    );

    const trigger = screen.getByRole('button', { name: /1 个模型.*1 个待核价/ });
    expect(within(trigger).queryByText(/models\.dev/)).not.toBeInTheDocument();
    expect(screen.queryByText('单位：美元 / 百万 Token')).not.toBeInTheDocument();
    fireEvent.click(trigger);
    expect(screen.getByText('单位：美元 / 百万 Token')).toBeInTheDocument();
    expect(screen.getByText('待核价（暂按 default 估算）')).toBeInTheDocument();
  });

  it('可视化编辑只改动所编辑的格子，待核价行改后标为用户修改，其余行原样保留（T10.171）', () => {
    const pendingMeta = { status: 'auto_discovered', price_source: 'tool_fallback', fallback_key: 'codex-agent' };
    // 缓存读价照抄后端的兜底估算输出（1.5 × 0.1），不写成 0.15（T10.171 评审 P1-1）。
    const cacheInput = 0.15000000000000002;
    const prices = {
      'claude-sonnet-5': { input: 2, output: 10, cache_input: 0.2, cache_write: 2.5 },
      'future-model-y': { input: 1.5, output: 2, cache_input: cacheInput, cache_write: 1.5, _meta: pendingMeta },
      'future-model-z': { input: 1.5, output: 2, cache_input: cacheInput, cache_write: 1.5, _meta: pendingMeta },
    };
    const onPricesChange = vi.fn();
    render(
      <PricingSection
        pricesText={JSON.stringify(prices)}
        pricesError=""
        pricesLoadError=""
        pricesLoading={false}
        pricesDirty={false}
        busy={busyState()}
        onPricesChange={onPricesChange}
        onReloadPrices={vi.fn()}
        onSavePrices={vi.fn()}
        onResetPrices={vi.fn()}
        onImportModelsDevPrice={vi.fn(async () => true)}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /3 个模型.*2 个待核价/ }));

    fireEvent.change(screen.getByLabelText('future-model-y 输入'), { target: { value: '0.9' } });
    const afterPendingEdit = JSON.parse(onPricesChange.mock.calls[0][0]);
    expect(afterPendingEdit['future-model-y']).toEqual({
      input: 0.9,
      output: 2,
      cache_input: cacheInput,
      cache_write: 1.5,
      _meta: { status: 'user_edited', price_source: 'user_override', fallback_key: 'codex-agent' },
    });
    // 未碰过的待核价行保留标记，后端据此不写入覆盖文件。
    expect(afterPendingEdit['future-model-z']).toEqual(prices['future-model-z']);
    expect(afterPendingEdit['claude-sonnet-5']).toEqual(prices['claude-sonnet-5']);

    fireEvent.change(screen.getByLabelText('claude-sonnet-5 输出'), { target: { value: '12' } });
    const afterBundledEdit = JSON.parse(onPricesChange.mock.calls[1][0]);
    expect(afterBundledEdit['claude-sonnet-5']).toEqual({ ...prices['claude-sonnet-5'], output: 12 });
    expect(afterBundledEdit['future-model-y']).toEqual(prices['future-model-y']);
  });

  it('价格表保存或恢复期间显示动作反馈并锁定重复操作', () => {
    render(
      <PricingSection
        pricesText={JSON.stringify({ 'gpt-5-codex': { input: 1, output: 2 } })}
        pricesError=""
        pricesLoadError=""
        pricesLoading={false}
        pricesDirty={true}
        busy={busyState(true)}
        onPricesChange={vi.fn()}
        onReloadPrices={vi.fn()}
        onSavePrices={vi.fn()}
        onResetPrices={vi.fn()}
        onImportModelsDevPrice={vi.fn(async () => true)}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /1 个模型/ }));

    const saveButton = screen.getByRole('button', { name: '正在保存价格表' });
    const resetButton = screen.getByRole('button', { name: '正在恢复默认价格表' });
    expect(saveButton).toBeDisabled();
    expect(saveButton).toHaveAttribute('aria-busy', 'true');
    expect(saveButton).toHaveTextContent('保存中…');
    expect(resetButton).toBeDisabled();
    expect(resetButton).toHaveAttribute('aria-busy', 'true');
    expect(resetButton).toHaveTextContent('恢复中…');
  });

  it('价格表读取失败时保留快照并提供显式重试', () => {
    const onReloadPrices = vi.fn();
    render(
      <PricingSection
        pricesText={JSON.stringify({ 'gpt-5-codex': { input: 1, output: 2 } })}
        pricesError=""
        pricesLoadError="读取价格表失败: database is locked"
        pricesLoading={false}
        pricesDirty={false}
        busy={busyState()}
        onPricesChange={vi.fn()}
        onReloadPrices={onReloadPrices}
        onSavePrices={vi.fn()}
        onResetPrices={vi.fn()}
        onImportModelsDevPrice={vi.fn(async () => true)}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('读取价格表失败');
    expect(screen.getByRole('alert')).toHaveTextContent('仍显示上次读取到的价格表');
    fireEvent.click(screen.getByRole('button', { name: '重新读取价格表' }));
    expect(onReloadPrices).toHaveBeenCalledTimes(1);
  });

  it('价格表读取中显示持续状态并锁定重试', () => {
    render(
      <PricingSection
        pricesText=""
        pricesError=""
        pricesLoadError=""
        pricesLoading
        pricesDirty={false}
        busy={busyState()}
        onPricesChange={vi.fn()}
        onReloadPrices={vi.fn()}
        onSavePrices={vi.fn()}
        onResetPrices={vi.fn()}
        onImportModelsDevPrice={vi.fn(async () => true)}
      />,
    );

    const reloadButton = screen.getByRole('button', { name: '正在读取价格表' });
    expect(screen.getByRole('status')).toHaveTextContent('正在读取价格表');
    expect(reloadButton).toBeDisabled();
  });
});
