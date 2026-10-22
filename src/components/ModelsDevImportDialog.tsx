import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { invoke } from '@tauri-apps/api/core';
import { AlertTriangle, Check, Database, RefreshCw, Search, X } from 'lucide-react';
import type { ModelsDevCandidate, ModelsDevSearchResponse } from '../types';
import { focusWrapTarget } from '../utils/frontendContracts';

type CurrentPrice = Record<'input' | 'output' | 'cache_input' | 'cache_write', number>;
type SearchAction = 'initial' | 'search' | 'refresh' | null;

interface ModelsDevImportDialogProps {
  modelKey: string;
  observedModel: string;
  tools: string[];
  currentPrice: CurrentPrice;
  pricesDirty: boolean;
  saving: boolean;
  onClose: () => void;
  onImport: (modelKey: string, candidate: ModelsDevCandidate) => Promise<boolean>;
}

const PRICE_ROWS = [
  { key: 'input', currentKey: 'input', label: '输入' },
  { key: 'output', currentKey: 'output', label: '输出' },
  { key: 'cacheInput', currentKey: 'cache_input', label: '缓存读' },
  { key: 'cacheWrite', currentKey: 'cache_write', label: '缓存写' },
] as const;

function formatPrice(value: number | null | undefined) {
  return typeof value === 'number' && Number.isFinite(value) ? `$${value.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')}` : '未提供';
}

export function ModelsDevImportDialog({
  modelKey,
  observedModel,
  tools,
  currentPrice,
  pricesDirty,
  saving,
  onClose,
  onImport,
}: ModelsDevImportDialogProps) {
  const [query, setQuery] = useState(observedModel);
  const [result, setResult] = useState<ModelsDevSearchResponse | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [loadingAction, setLoadingAction] = useState<SearchAction>('initial');
  const [error, setError] = useState('');
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  const savingRef = useRef(saving);
  const wasSavingRef = useRef(saving);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    savingRef.current = saving;
    if (saving && !wasSavingRef.current) dialogRef.current?.focus();
    wasSavingRef.current = saving;
  }, [saving]);

  const selected = result?.candidates[selectedIndex] || null;
  const loading = loadingAction !== null;
  const estimatedFields = useMemo(() => {
    if (!selected) return [];
    return [
      selected.cacheInput == null ? '缓存读' : null,
      selected.cacheWrite == null ? '缓存写' : null,
    ].filter((field): field is string => !!field);
  }, [selected]);

  const runSearch = async (forceRefresh = false, isInitialLoad = false) => {
    if (!isInitialLoad && (loading || saving)) return;
    const normalized = query.trim();
    if (!normalized) {
      setError('请输入要搜索的模型 ID');
      return;
    }
    setLoadingAction(isInitialLoad ? 'initial' : forceRefresh ? 'refresh' : 'search');
    setError('');
    try {
      const response = await invoke<ModelsDevSearchResponse>('search_models_dev_prices', {
        model: normalized,
        tools,
        forceRefresh,
      });
      setResult(response);
      setSelectedIndex(0);
    } catch (requestError) {
      setResult(null);
      setError(String(requestError));
    } finally {
      setLoadingAction(null);
    }
  };

  useEffect(() => {
    void runSearch(false, true);
    // The initial lookup intentionally runs only when the pending model changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [observedModel]);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    (closeRef.current?.disabled ? dialogRef.current : closeRef.current)?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (!savingRef.current) onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;

      const dialog = closeRef.current?.closest('[role="dialog"]');
      if (!dialog) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )).filter((element) => !element.hasAttribute('hidden'));
      if (focusable.length === 0) {
        event.preventDefault();
        dialogRef.current?.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const wrapTarget = focusWrapTarget(
        event.shiftKey ? 'backward' : 'forward',
        document.activeElement === first,
        document.activeElement === last,
      );
      if (wrapTarget === 'last') {
        event.preventDefault();
        last.focus();
      } else if (wrapTarget === 'first') {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      previous?.focus();
    };
  }, [modelKey, observedModel]);

  const confirmImport = async () => {
    if (!selected?.importable) return;
    if (await onImport(modelKey, selected)) onClose();
  };

  const dialog = (
    <div className="modal-overlay models-dev-overlay" onClick={() => !saving && onClose()}>
      <section
        ref={dialogRef}
        className="modal-content models-dev-dialog tl-scrollbar"
        role="dialog"
        aria-modal="true"
        aria-labelledby="models-dev-dialog-title"
        tabIndex={-1}
        aria-busy={saving || loading}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="modal-header models-dev-header">
          <div>
            <div className="models-dev-eyebrow">MODELS.DEV PRICE IMPORT</div>
            <h2 className="modal-title models-dev-title" id="models-dev-dialog-title">选择计费来源</h2>
            <p className="modal-subtitle">
              待核价模型 <code>{observedModel}</code> · 单位 USD / 百万 Token
            </p>
          </div>
          <button ref={closeRef} className="modal-close" type="button" onClick={onClose} disabled={saving} aria-label="关闭">
            <X className="h-5 w-5" />
          </button>
        </header>

        <div className="models-dev-search-row">
          <div className="models-dev-search-input-wrap">
            <Search className="h-4 w-4" />
            <input
              className="models-dev-search-input"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void runSearch(false);
                }
              }}
              disabled={loading || saving}
              aria-label="搜索 models.dev 模型"
            />
          </div>
          <button
            className="secondary-inline"
            type="button"
            onClick={() => void runSearch(false)}
            disabled={loading || saving}
            aria-busy={loadingAction === 'search'}
            title={loadingAction === 'search' ? '正在搜索模型目录' : '搜索模型目录'}
          >
            <Search className={`h-4 w-4 ${loadingAction === 'search' ? 'animate-spin' : ''}`} />
            {loadingAction === 'search' ? '搜索中…' : '搜索'}
          </button>
          <button
            className="ghost-inline"
            type="button"
            onClick={() => void runSearch(true)}
            disabled={loading || saving}
            aria-busy={loadingAction === 'refresh'}
            title={loadingAction === 'refresh' ? '正在刷新模型目录' : '刷新模型目录缓存'}
          >
            <RefreshCw className={`h-4 w-4 ${loadingAction === 'refresh' ? 'animate-spin' : ''}`} />
            {loadingAction === 'refresh' ? '刷新中…' : '刷新目录'}
          </button>
        </div>

        {error && <div className="models-dev-notice models-dev-notice-error" role="alert">{error}</div>}
        {result?.warning && <div className="models-dev-notice models-dev-notice-warning" role="status" aria-live="polite">{result.warning}</div>}
        {pricesDirty && (
          <div className="models-dev-notice models-dev-notice-warning">
            <AlertTriangle className="h-4 w-4" />
            导入时会一并保存价格表中尚未保存的修改。
          </div>
        )}

        <div className="models-dev-body">
          <div className="models-dev-results tl-scrollbar" aria-busy={loading}>
            {loading ? (
              <div className="models-dev-empty">
                <RefreshCw className="h-5 w-5 animate-spin" />
                正在获取模型目录…
              </div>
            ) : result && result.candidates.length > 0 ? (
              result.candidates.map((candidate, index) => (
                <button
                  key={`${candidate.providerId}:${candidate.modelId}`}
                  className={`models-dev-candidate ${selectedIndex === index ? 'selected' : ''}`}
                  type="button"
                  aria-pressed={selectedIndex === index}
                  onClick={() => setSelectedIndex(index)}
                  disabled={saving}
                >
                  <span className="models-dev-candidate-check">
                    {selectedIndex === index && <Check className="h-3.5 w-3.5" />}
                  </span>
                  <span className="models-dev-candidate-main">
                    <span className="models-dev-candidate-title">
                      <strong title={candidate.modelName}>{candidate.modelName}</strong>
                      <span>{candidate.providerName}</span>
                    </span>
                    <code title={candidate.modelId}>{candidate.modelId}</code>
                    <span className="models-dev-match-reason">{candidate.matchReason}</span>
                  </span>
                  <span className="models-dev-candidate-cost">
                    <strong>{formatPrice(candidate.input)} / {formatPrice(candidate.output)}</strong>
                    <small>输入 / 输出</small>
                    {!candidate.importable && <em>价格不完整</em>}
                  </span>
                </button>
              ))
            ) : result ? (
              <div className="models-dev-empty">没有找到匹配模型，可以修改关键词后重新搜索。</div>
            ) : null}
          </div>

          <aside className="models-dev-preview">
            {selected ? (
              <>
                <div className="models-dev-preview-heading">
                  <div>
                    <span>价格对比 · {selected.providerName}</span>
                    <strong title={selected.modelName}>{selected.modelName}</strong>
                    <code className="models-dev-preview-model-id" title={selected.modelId}>{selected.modelId}</code>
                  </div>
                  {selected.lastUpdated && <small>数据更新：{selected.lastUpdated}</small>}
                </div>
                <div className="models-dev-price-grid">
                  <div className="models-dev-price-grid-head">项目</div>
                  <div className="models-dev-price-grid-head">当前兜底价</div>
                  <div className="models-dev-price-grid-head">导入价格</div>
                  {PRICE_ROWS.map((row) => {
                    const imported = selected[row.key];
                    return (
                      <div className="models-dev-price-row" key={row.key}>
                        <span>{row.label}</span>
                        <span>{formatPrice(currentPrice[row.currentKey])}</span>
                        <strong className={imported == null ? 'estimated' : ''}>
                          {imported == null ? `${formatPrice(currentPrice[row.currentKey])}（估算）` : formatPrice(imported)}
                        </strong>
                      </div>
                    );
                  })}
                </div>
                {estimatedFields.length > 0 && (
                  <div className="models-dev-inline-warning">
                    <AlertTriangle className="h-4 w-4" />
                    models.dev 未提供{estimatedFields.join('、')}价格，将保留当前兜底估算值并记录来源。
                  </div>
                )}
                {selected.hasTieredPricing && (
                  <div className="models-dev-inline-warning">
                    <AlertTriangle className="h-4 w-4" />
                    该来源存在上下文分档价格，本次仅导入标准档。
                  </div>
                )}
                {!selected.importable && (
                  <div className="models-dev-inline-warning danger">
                    此候选项缺少输入或输出价格，不能导入。
                  </div>
                )}
              </>
            ) : (
              <div className="models-dev-empty">选择一个候选项后可查看价格差异。</div>
            )}
          </aside>
        </div>

        <footer className="models-dev-footer">
          <div className="models-dev-cache-state">
            <Database className="h-4 w-4" />
            {result ? `目录时间 ${new Date(result.fetchedAt).toLocaleString()}${result.cacheStatus === 'stale' ? '（离线缓存）' : ''}` : '目录尚未加载'}
          </div>
          <div className="models-dev-footer-actions">
            <button className="ghost-inline" type="button" onClick={onClose} disabled={saving}>取消</button>
            <button
              className="primary-inline"
              type="button"
              onClick={() => void confirmImport()}
              disabled={!selected?.importable || saving || loading}
              aria-busy={saving}
              title={saving ? '正在保存价格配置' : '导入并保存价格配置'}
            >
              {saving && <RefreshCw className="h-4 w-4 animate-spin" />}
              {saving ? '保存中…' : '导入并保存'}
            </button>
          </div>
        </footer>
      </section>
    </div>
  );

  return typeof document !== 'undefined' ? createPortal(dialog, document.body) : dialog;
}
