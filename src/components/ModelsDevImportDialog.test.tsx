import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import type { ModelsDevSearchResponse } from '../types';
import { ModelsDevImportDialog } from './ModelsDevImportDialog';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

const SEARCH_RESPONSE: ModelsDevSearchResponse = {
  query: 'gpt-5',
  fetchedAt: '2026-08-21T02:10:00.000Z',
  cacheStatus: 'fresh',
  warning: null,
  candidates: [{
    providerId: 'openai',
    providerName: 'OpenAI',
    modelId: 'gpt-5',
    modelName: 'GPT-5',
    input: 1,
    output: 2,
    cacheInput: 0.1,
    cacheWrite: 0.2,
    lastUpdated: '2026-08-20',
    status: 'active',
    hasTieredPricing: false,
    importable: true,
    matchReason: '精确匹配',
  }],
};

const CURRENT_PRICE = {
  input: 1,
  output: 2,
  cache_input: 0.1,
  cache_write: 0.2,
};

describe('ModelsDevImportDialog', () => {
  it('以可访问选中状态标明实际将导入的候选', async () => {
    const second = { ...SEARCH_RESPONSE.candidates[0], providerId: 'azure', providerName: 'Azure', input: 3 };
    vi.mocked(invoke).mockResolvedValue({ ...SEARCH_RESPONSE, candidates: [...SEARCH_RESPONSE.candidates, second] });
    const onImport = vi.fn(async () => true);
    render(<ModelsDevImportDialog modelKey="gpt-5" observedModel="gpt-5" tools={['codex']}
      currentPrice={CURRENT_PRICE} pricesDirty={false} saving={false} onClose={vi.fn()} onImport={onImport} />);
    const first = await screen.findByRole('button', { name: /OpenAI/ });
    const next = screen.getByRole('button', { name: /Azure/ });
    expect(first).toHaveAttribute('aria-pressed', 'true');
    expect(next).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(next);
    expect(first).toHaveAttribute('aria-pressed', 'false');
    expect(next).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: '导入并保存' }));
    await waitFor(() => expect(onImport).toHaveBeenCalledWith('gpt-5', second));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(invoke).mockResolvedValue(SEARCH_RESPONSE);
  });

  it('打开后聚焦关闭按钮、环回 Tab 焦点并在卸载后恢复原焦点', async () => {
    const launcher = document.createElement('button');
    launcher.textContent = '打开模型导入';
    document.body.appendChild(launcher);
    launcher.focus();
    const onClose = vi.fn();
    const view = render(
      <ModelsDevImportDialog
        modelKey="gpt-5"
        observedModel="gpt-5"
        tools={['codex']}
        currentPrice={CURRENT_PRICE}
        pricesDirty={false}
        saving={false}
        onClose={onClose}
        onImport={vi.fn(async () => true)}
      />,
    );

    const close = screen.getByRole('button', { name: '关闭' });
    await waitFor(() => expect(close).toHaveFocus());
    const submit = screen.getByRole('button', { name: '导入并保存' });
    submit.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(close).toHaveFocus();
    close.focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(submit).toHaveFocus();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(launcher).toHaveFocus();
    launcher.remove();
  });

  it('保存进行中不允许 Escape 绕过进行中的导入', async () => {
    const onClose = vi.fn();
    const view = render(
      <ModelsDevImportDialog
        modelKey="gpt-5"
        observedModel="gpt-5"
        tools={['codex']}
        currentPrice={CURRENT_PRICE}
        pricesDirty={false}
        saving={false}
        onClose={onClose}
        onImport={vi.fn(async () => true)}
      />,
    );

    await waitFor(() => expect(screen.getByRole('button', { name: '关闭' })).toHaveFocus());
    view.rerender(
      <ModelsDevImportDialog
        modelKey="gpt-5"
        observedModel="gpt-5"
        tools={['codex']}
        currentPrice={CURRENT_PRICE}
        pricesDirty={false}
        saving
        onClose={onClose}
        onImport={vi.fn(async () => true)}
      />,
    );
    expect(screen.getByRole('dialog')).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(screen.getByRole('dialog')).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    view.unmount();
  });

  it('搜索和保存进行中显示动作级反馈并阻止重复触发', async () => {
    let resolveSearch: ((value: ModelsDevSearchResponse) => void) | undefined;
    vi.mocked(invoke).mockImplementationOnce(() => new Promise((resolve) => {
      resolveSearch = resolve as (value: ModelsDevSearchResponse) => void;
    }));
    const onImport = vi.fn(() => new Promise<boolean>(() => {}));
    const view = render(
      <ModelsDevImportDialog
        modelKey="gpt-5"
        observedModel="gpt-5"
        tools={['codex']}
        currentPrice={CURRENT_PRICE}
        pricesDirty={false}
        saving={false}
        onClose={vi.fn()}
        onImport={onImport}
      />,
    );

    expect(screen.getByText('正在获取模型目录…')).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-busy', 'true');
    resolveSearch?.(SEARCH_RESPONSE);
    await waitFor(() => expect(screen.getByRole('button', { name: '导入并保存' })).toBeEnabled());

    let resolveRefresh: ((value: ModelsDevSearchResponse) => void) | undefined;
    vi.mocked(invoke).mockImplementationOnce(() => new Promise((resolve) => {
      resolveRefresh = resolve as (value: ModelsDevSearchResponse) => void;
    }));
    fireEvent.click(screen.getByRole('button', { name: '刷新目录' }));
    expect(screen.getByRole('button', { name: '刷新中…' })).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('button', { name: '搜索' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '刷新中…' }));
    expect(invoke).toHaveBeenCalledTimes(2);
    resolveRefresh?.(SEARCH_RESPONSE);
    await waitFor(() => expect(screen.getByRole('button', { name: '刷新目录' })).toBeEnabled());

    fireEvent.click(screen.getByRole('button', { name: '导入并保存' }));
    await waitFor(() => expect(onImport).toHaveBeenCalledTimes(1));
    view.rerender(
      <ModelsDevImportDialog
        modelKey="gpt-5"
        observedModel="gpt-5"
        tools={['codex']}
        currentPrice={CURRENT_PRICE}
        pricesDirty={false}
        saving
        onClose={vi.fn()}
        onImport={onImport}
      />,
    );
    expect(screen.getByRole('button', { name: '保存中…' })).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-busy', 'true');
    view.unmount();
  });
});
