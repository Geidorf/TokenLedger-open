import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import type { ModelsDevCandidate } from '../types';
import { useSettings } from './useSettings';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));

const invokeMock = invoke as unknown as Mock;

// codex-agent 兜底的缓存读价由后端按输入价的 10% 算出，1.5 × 0.1 在 f64 里就是这个值；
// 夹具照抄后端真实输出，而不是写成 0.15（T10.171 评审 P1-1）。
const CODEX_AGENT_CACHE_INPUT = 0.15000000000000002;

// 后端 get_prices 返回的生效价格表：内置型号、两个待核价型号（自动发现，按 codex-agent 兜底）。
function backendPrices(): Record<string, unknown> {
  return {
    'claude-sonnet-5': { input: 2, output: 10, cache_input: 0.2, cache_write: 2.5 },
    'future-model-y': {
      input: 1.5,
      output: 2,
      cache_input: CODEX_AGENT_CACHE_INPUT,
      cache_write: 1.5,
      _meta: {
        status: 'auto_discovered',
        price_source: 'tool_fallback',
        fallback_key: 'codex-agent',
        observed_model: 'future-model-y',
        tools: ['codex'],
      },
    },
    'future-model-z': {
      input: 1.5,
      output: 2,
      cache_input: CODEX_AGENT_CACHE_INPUT,
      cache_write: 1.5,
      _meta: {
        status: 'auto_discovered',
        price_source: 'tool_fallback',
        fallback_key: 'codex-agent',
        observed_model: 'future-model-z',
        tools: ['codex'],
      },
    },
  };
}

const candidate: ModelsDevCandidate = {
  providerId: 'example-provider',
  providerName: 'Example Provider',
  modelId: 'future-model-y',
  modelName: 'Future Model Y',
  input: 0.4,
  output: 1.6,
  cacheInput: null,
  cacheWrite: null,
  lastUpdated: '2026-09-01',
  status: null,
  hasTieredPricing: false,
  importable: true,
  matchReason: 'exact',
};

function renderSettings(confirm = vi.fn(async () => true)) {
  const props = {
    showMessage: vi.fn(),
    confirm,
    loadStats: vi.fn(async () => {}),
    loadQuotas: vi.fn(async () => {}),
    loadQuotaSyncStatus: vi.fn(async () => {}),
    cloudStatus: { configured: false, authenticated: false, email: '', userId: '' },
    cloudSetup: { capabilityVerified: false, firstSyncCompleted: false },
    setSettingsAnchor: vi.fn(),
    setBusy: vi.fn(),
  };
  return { ...renderHook(() => useSettings(props)), props };
}

function savedPrices(): Record<string, Record<string, unknown>> {
  const call = invokeMock.mock.calls.find(([command]) => command === 'save_prices');
  expect(call).toBeDefined();
  return (call?.[1] as { prices: Record<string, Record<string, unknown>> }).prices;
}

function getPricesCalls() {
  return invokeMock.mock.calls.filter(([command]) => command === 'get_prices').length;
}

describe('useSettings 设置回读结果（T10.311c）', () => {
  it('成功返回 true，失败返回 false 且 silent 模式不发通用错误提示', async () => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue({});
    const { result, props } = renderSettings();

    await act(async () => { expect(await result.current.loadSettings(true)).toBe(true); });
    invokeMock.mockRejectedValueOnce(new Error('settings read failed'));
    await act(async () => { expect(await result.current.loadSettings(true)).toBe(false); });

    expect(props.showMessage).not.toHaveBeenCalled();
  });
});

describe('useSettings 价格表保存与导入（T10.171）', () => {
  let current: Record<string, unknown>;

  beforeEach(() => {
    current = backendPrices();
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'get_prices') return current;
      if (command === 'save_prices') return { message: 'Saved price overrides.', repriced: 0 };
      if (command === 'reset_prices') return { message: '已恢复默认价格。', prices: backendPrices(), repriced: 0 };
      return undefined;
    });
  });

  for (const action of ['save', 'import', 'reset'] as const) {
    it(`${action}价格落盘但重算待恢复时保留保存结果并显示警告`, async () => {
      const warning = '价格已保存，但历史估算费用重算未完成；再次保存相同价格或重启应用会自动重试。';
      invokeMock.mockImplementation(async (command: string) => {
        if (command === 'get_prices') return current;
        if (command === 'save_prices' || command === 'reset_prices') return {
          saved: true, message: '价格已保存', repricing_pending: true, warning, prices: current,
        };
        return undefined;
      });
      const { result, props } = renderSettings();
      await act(async () => { await result.current.loadPrices(); });
      act(() => result.current.setPricesDirty(true));
      await act(async () => {
        if (action === 'save') await result.current.savePrices();
        else if (action === 'reset') await result.current.resetPrices();
        else expect(await result.current.importModelsDevPrice('future-model-y', candidate)).toBe(true);
      });
      expect(props.showMessage).toHaveBeenCalledWith('warning', warning);
      expect(result.current.pricesDirty).toBe(false);
      expect(JSON.parse(result.current.pricesText)).toEqual(current);
      expect(props.showMessage.mock.calls.some(([kind]) => kind === 'error')).toBe(false);
    });
  }

  it('编辑器载入后价格表已在线更新：保存被拒时亮出「重新读取」，草稿保留在编辑框', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'get_prices') return current;
      if (command === 'save_prices') {
        throw '价格表已更新到第 3 版，编辑框里还是第 2 版的价格。为了不把旧价当成你的自定义价格保存，这次没有保存；请先复制需要保留的修改，点「重新读取」后再改。';
      }
      return undefined;
    });
    const { result } = renderSettings();
    await act(async () => { await result.current.loadPrices(); });
    act(() => result.current.setPricesDirty(true));
    await act(async () => { await result.current.savePrices(); });
    expect(result.current.pricesLoadError).toContain('重新读取');
    expect(result.current.pricesDirty).toBe(true);
    await act(async () => { await result.current.loadPrices(); });
    expect(result.current.pricesLoadError).toBe('');
  });

  it('保存价格表整表提交，未改动的待核价行保持原标记，保存后重读后端生效价格', async () => {
    const { result } = renderSettings();
    await act(async () => { await result.current.loadPrices(); });
    const edited = JSON.parse(result.current.pricesText) as Record<string, Record<string, unknown>>;
    edited['claude-sonnet-5'].input = 2.25;
    act(() => {
      result.current.setPricesText(JSON.stringify(edited, null, 2));
      result.current.setPricesDirty(true);
    });

    current = { ...backendPrices(), 'claude-sonnet-5': { input: 2.25, output: 10, cache_input: 0.2, cache_write: 2.5 } };
    await act(async () => { await result.current.savePrices(); });

    const sent = savedPrices();
    expect(sent['claude-sonnet-5']).toEqual({ input: 2.25, output: 10, cache_input: 0.2, cache_write: 2.5 });
    // 后端据标记与兜底价判断「未改动」，前端不得改写这些行。
    expect(sent['future-model-y']).toEqual(backendPrices()['future-model-y']);
    expect(sent['future-model-z']).toEqual(backendPrices()['future-model-z']);
    expect(getPricesCalls()).toBe(2);
    expect(JSON.parse(result.current.pricesText)).toEqual(current);
    expect(result.current.pricesDirty).toBe(false);
  });

  it('从 models.dev 导入只改目标行，保留 fallback_key 并标出估算的缓存价', async () => {
    const { result } = renderSettings();
    await act(async () => { await result.current.loadPrices(); });

    let imported = false;
    await act(async () => { imported = await result.current.importModelsDevPrice('future-model-y', candidate); });

    expect(imported).toBe(true);
    const sent = savedPrices();
    expect(sent['future-model-y']).toMatchObject({
      input: 0.4,
      output: 1.6,
      cache_input: CODEX_AGENT_CACHE_INPUT,
      cache_write: 1.5,
      _meta: {
        status: 'models_dev_imported',
        price_source: 'models.dev',
        fallback_key: 'codex-agent',
        provider_id: 'example-provider',
        estimated_fields: ['cache_input', 'cache_write'],
        tools: ['codex'],
      },
    });
    expect(sent['future-model-z']).toEqual(backendPrices()['future-model-z']);
    expect(sent['claude-sonnet-5']).toEqual(backendPrices()['claude-sonnet-5']);
    // 导入后以后端重读的生效价格为准。
    expect(getPricesCalls()).toBe(2);
  });

  it('导入价格与当前估算相同时照样按导入提交，提示与后端的保存结果一致', async () => {
    const { result, props } = renderSettings();
    await act(async () => { await result.current.loadPrices(); });
    const sameAsEstimate: ModelsDevCandidate = { ...candidate, input: 1.5, output: 2 };

    await act(async () => { await result.current.importModelsDevPrice('future-model-y', sameAsEstimate); });

    expect(savedPrices()['future-model-y']).toMatchObject({
      input: 1.5,
      output: 2,
      _meta: { status: 'models_dev_imported', estimated_fields: ['cache_input', 'cache_write'] },
    });
    // 后端对导入行保留 models.dev 给出的价格，即使与估算相同（T10.171 评审 P2-2、U-7），「已导入」属实。
    expect(props.showMessage).toHaveBeenCalledWith(
      'success',
      '已从 Example Provider 导入 Future Model Y，缺失的缓存价格继续使用原兜底估算',
    );
  });

  it('有未保存的手动修改时，导入需确认，并把手动修改一并提交', async () => {
    const confirm = vi.fn(async () => true);
    const { result } = renderSettings(confirm);
    await act(async () => { await result.current.loadPrices(); });
    const edited = JSON.parse(result.current.pricesText) as Record<string, Record<string, unknown>>;
    edited['future-model-z'] = {
      ...edited['future-model-z'],
      input: 0.9,
      _meta: { ...(edited['future-model-z']._meta as Record<string, unknown>), status: 'user_edited', price_source: 'user_override' },
    };
    act(() => {
      result.current.setPricesText(JSON.stringify(edited, null, 2));
      result.current.setPricesDirty(true);
    });

    await act(async () => { await result.current.importModelsDevPrice('future-model-y', candidate); });

    expect(confirm).toHaveBeenCalledTimes(1);
    const sent = savedPrices();
    expect(sent['future-model-z']).toMatchObject({ input: 0.9, _meta: { status: 'user_edited', fallback_key: 'codex-agent' } });
    expect(sent['future-model-y']).toMatchObject({ input: 0.4, _meta: { status: 'models_dev_imported' } });
  });

  it('恢复默认用后端返回的价格表替换编辑器内容', async () => {
    const { result } = renderSettings();
    act(() => {
      result.current.setPricesText(JSON.stringify({ 'claude-sonnet-5': { input: 9, output: 9 } }));
      result.current.setPricesDirty(true);
    });

    await act(async () => { await result.current.resetPrices(); });

    expect(invokeMock).toHaveBeenCalledWith('reset_prices');
    expect(JSON.parse(result.current.pricesText)).toEqual(backendPrices());
    expect(result.current.pricesDirty).toBe(false);
  });
});
