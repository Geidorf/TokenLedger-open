import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, DollarSign, Download, RefreshCw, Search, X } from 'lucide-react';
import type { BusyState, ModelsDevCandidate } from '../../types';
import { ModelsDevImportDialog } from '../ModelsDevImportDialog';
import { PriceMigrationNotice } from './PriceMigrationNotice';
import { SettingsActionRow, SettingsRow, SettingsSection } from './SettingsPrimitives';

export interface PricingSectionProps {
  pricesText: string;
  pricesError: string;
  pricesLoadError: string;
  pricesLoading: boolean;
  pricesDirty: boolean;
  busy: BusyState;
  onPricesChange: (text: string) => void;
  onReloadPrices: () => void | Promise<void>;
  onSavePrices: () => void;
  onResetPrices: () => void;
  onImportModelsDevPrice: (modelKey: string, candidate: ModelsDevCandidate) => Promise<boolean>;
}

const PRICE_FIELDS = [
  { key: 'input', label: '输入' },
  { key: 'output', label: '输出' },
  { key: 'cache_input', label: '缓存读' },
  { key: 'cache_write', label: '缓存写' },
] as const;

type PriceField = (typeof PRICE_FIELDS)[number]['key'];
type PriceModelConfig = Partial<Record<PriceField, number>> & Record<string, unknown>;
type PricesConfig = Record<string, PriceModelConfig>;

function parsePricesText(text: string): PricesConfig | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const entries = Object.entries(parsed as Record<string, unknown>);
    if (entries.some(([, value]) => !value || typeof value !== 'object' || Array.isArray(value))) return null;
    return parsed as PricesConfig;
  } catch {
    return null;
  }
}

function formatPriceValue(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
}

function autoDiscoveredFallback(config: PriceModelConfig) {
  const meta = config._meta;
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
  const record = meta as Record<string, unknown>;
  if (record.status !== 'auto_discovered') return null;
  return typeof record.fallback_key === 'string' ? record.fallback_key : 'default';
}

function autoDiscoveredInfo(config: PriceModelConfig) {
  const fallback = autoDiscoveredFallback(config);
  if (!fallback) return null;
  const meta = config._meta as Record<string, unknown>;
  return {
    fallback,
    observedModel: typeof meta.observed_model === 'string' ? meta.observed_model : '',
    tools: Array.isArray(meta.tools) ? meta.tools.filter((tool): tool is string => typeof tool === 'string') : [],
  };
}

function modelsDevProvider(config: PriceModelConfig) {
  const meta = config._meta;
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
  const record = meta as Record<string, unknown>;
  if (record.status !== 'models_dev_imported') return null;
  return typeof record.provider_name === 'string'
    ? record.provider_name
    : typeof record.provider_id === 'string'
      ? record.provider_id
      : 'models.dev';
}

export function PricingSection(props: PricingSectionProps) {
  const [pricingMode, setPricingMode] = useState<'visual' | 'json'>('visual');
  const [pricingExpanded, setPricingExpanded] = useState(false);
  const [priceSearch, setPriceSearch] = useState('');
  const [modelsDevTarget, setModelsDevTarget] = useState<{
    modelKey: string;
    config: PriceModelConfig;
    observedModel: string;
    tools: string[];
  } | null>(null);
  const parsedPrices = useMemo(() => parsePricesText(props.pricesText), [props.pricesText]);
  const priceRows = useMemo(
    () => (parsedPrices ? Object.entries(parsedPrices).sort(([a], [b]) => a.localeCompare(b)) : []),
    [parsedPrices],
  );
  const pendingPriceCount = useMemo(
    () => priceRows.filter(([, config]) => autoDiscoveredInfo(config) !== null).length,
    [priceRows],
  );
  const filteredPriceRows = useMemo(() => {
    const query = priceSearch.trim().toLocaleLowerCase();
    if (!query) return priceRows;
    return priceRows.filter(([model, config]) => {
      const source = modelsDevProvider(config) || '';
      const fallback = autoDiscoveredFallback(config) || '';
      return `${model}\n${source}\n${fallback}`.toLocaleLowerCase().includes(query);
    });
  }, [priceRows, priceSearch]);
  const pricesBusy = props.busy.prices;
  const hasPriceSnapshot = props.pricesText.trim().length > 0;
  const resetPricesLabel = pricesBusy ? '正在恢复默认价格表' : '恢复默认价格表';
  const savePricesLabel = pricesBusy ? '正在保存价格表' : '保存价格表';

  useEffect(() => {
    if (props.pricesError || props.pricesLoadError) setPricingExpanded(true);
  }, [props.pricesError, props.pricesLoadError]);

  const updatePriceField = (model: string, field: PriceField, rawValue: string) => {
    const next = parsePricesText(props.pricesText);
    if (!next) return;
    const modelConfig: PriceModelConfig = { ...(next[model] || {}) };
    if (rawValue.trim() === '') {
      delete modelConfig[field];
    } else {
      const value = Number(rawValue);
      if (!Number.isFinite(value) || value < 0) return;
      modelConfig[field] = value;
    }
    const meta = modelConfig._meta;
    if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
      const metaRecord = meta as Record<string, unknown>;
      if (metaRecord.status === 'auto_discovered') {
        modelConfig._meta = {
          ...metaRecord,
          status: 'user_edited',
          price_source: 'user_override',
        };
      }
    }
    props.onPricesChange(JSON.stringify({ ...next, [model]: modelConfig }, null, 2));
  };

  return (
    <SettingsSection id="pricing" title="模型价格">
      <PriceMigrationNotice />
      <div className="settings-group">
        <SettingsRow
          label="模型价格"
          icon={DollarSign}
        >
          <button
            className="settings-pricing-disclosure"
            type="button"
            aria-expanded={pricingExpanded}
            aria-controls={pricingExpanded ? 'settings-pricing-editor' : undefined}
            onClick={() => setPricingExpanded((expanded) => !expanded)}
          >
            <span>
              <strong>{parsedPrices ? `${priceRows.length} 个模型` : '价格表需修复'}</strong>
              <small>
                {pendingPriceCount > 0
                  ? `${pendingPriceCount} 个待核价`
                  : '无待核价'}
              </small>
            </span>
            <ChevronDown className={pricingExpanded ? 'is-expanded' : ''} />
          </button>
        </SettingsRow>
        {(props.pricesLoadError || props.pricesLoading) && (
          <div
            className="settings-pricing-load-error"
            role={props.pricesLoadError ? 'alert' : 'status'}
            aria-live={props.pricesLoadError ? 'assertive' : 'polite'}
          >
            <div className="settings-pricing-load-error-copy">
              <strong>{props.pricesLoading ? '正在读取价格表…' : '价格表读取失败'}</strong>
              {!props.pricesLoading && <span>{props.pricesLoadError}</span>}
              {!props.pricesLoading && hasPriceSnapshot && (
                <small>仍显示上次读取到的价格表，可点击“重新读取”重试。</small>
              )}
            </div>
            <button
              className="secondary-inline"
              type="button"
              onClick={() => void props.onReloadPrices()}
              disabled={props.pricesLoading || pricesBusy}
              aria-busy={props.pricesLoading || undefined}
              aria-label={props.pricesLoading ? '正在读取价格表' : '重新读取价格表'}
              title={props.pricesLoading ? '正在读取价格表' : '重新读取价格表'}
            >
              <RefreshCw className={`h-4 w-4 ${props.pricesLoading ? 'animate-spin' : ''}`} />
              {props.pricesLoading ? '读取中…' : '重新读取'}
            </button>
          </div>
        )}
        {pricingExpanded && <div className="settings-pricing-expanded" id="settings-pricing-editor">
          <div className="settings-pricing-toolbar">
            <span className="settings-pricing-unit">单位：美元 / 百万 Token</span>
            <div className="segmented settings-mode-toggle" role="tablist" aria-label="价格表显示方式">
              <button
                className={pricingMode === 'visual' ? 'active' : ''}
                type="button"
                role="tab"
                aria-selected={pricingMode === 'visual'}
                onClick={() => setPricingMode('visual')}
              >
                可视化
              </button>
              <button
                className={pricingMode === 'json' ? 'active' : ''}
                type="button"
                role="tab"
                aria-selected={pricingMode === 'json'}
                onClick={() => setPricingMode('json')}
              >
                JSON
              </button>
            </div>
            <div className="settings-pricing-toolbar-actions">
              {pricingMode === 'visual' && (
                <label className="price-search">
                  <span className="sr-only">搜索模型价格</span>
                  <Search className="h-4 w-4" aria-hidden="true" />
                  <input
                    type="search"
                    value={priceSearch}
                    placeholder="搜索模型或来源"
                    onChange={(event) => setPriceSearch(event.target.value)}
                  />
                  {priceSearch && (
                    <button type="button" aria-label="清除价格搜索" onClick={() => setPriceSearch('')}>
                      <X className="h-4 w-4" />
                    </button>
                  )}
                </label>
              )}
              <button
                className="ghost-inline"
                type="button"
                onClick={props.onResetPrices}
                disabled={pricesBusy}
                aria-busy={pricesBusy || undefined}
                aria-label={resetPricesLabel}
                title={resetPricesLabel}
              >
                <RefreshCw className={`h-4 w-4 ${pricesBusy ? 'animate-spin' : ''}`} />
                {pricesBusy ? '恢复中…' : '恢复默认'}
              </button>
            </div>
          </div>
          <div className="settings-editor-row">
          {pricingMode === 'visual' ? (
            parsedPrices && priceRows.length > 0 ? (
              <div className="price-visual tl-scrollbar">
                <table className="price-table">
                  <thead>
                    <tr>
                      <th scope="col">模型</th>
                      {PRICE_FIELDS.map((field) => (
                        <th key={field.key} scope="col">
                          {field.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {filteredPriceRows.map(([model, config]) => (
                      <tr key={model}>
                        <th scope="row">
                          <div className="price-model-cell">
                            <span className="price-model-name" title={model}>{model}</span>
                            {autoDiscoveredInfo(config) && (
                              <span
                                className="price-status-badge"
                                title={`当前按 ${autoDiscoveredInfo(config)?.fallback} 暂估，请核对供应商官方价格`}
                              >
                                待核价（暂按 {autoDiscoveredInfo(config)?.fallback} 估算）
                              </span>
                            )}
                            {modelsDevProvider(config) && (
                              <span className="price-status-badge price-status-badge-source">
                                models.dev · {modelsDevProvider(config)}
                              </span>
                            )}
                            {autoDiscoveredInfo(config) && (
                              <button
                                className="price-import-button"
                                type="button"
                                onClick={() => {
                                  const info = autoDiscoveredInfo(config);
                                  if (!info) return;
                                  setModelsDevTarget({
                                    modelKey: model,
                                    config,
                                    observedModel: info.observedModel || model,
                                    tools: info.tools,
                                  });
                                }}
                                disabled={props.busy.prices}
                              >
                                <Download className="h-3.5 w-3.5" />
                                从 models.dev 导入
                              </button>
                            )}
                          </div>
                        </th>
                        {PRICE_FIELDS.map((field) => (
                          <td key={field.key}>
                            <input
                              className="price-field-input"
                              type="number"
                              min={0}
                              step="0.000001"
                              value={formatPriceValue(config[field.key])}
                              onChange={(event) => updatePriceField(model, field.key, event.target.value)}
                              disabled={props.busy.prices}
                              aria-label={`${model} ${field.label}`}
                            />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
                {filteredPriceRows.length === 0 && (
                  <div className="price-search-empty" role="status">
                    没有匹配“{priceSearch.trim()}”的模型价格。
                  </div>
                )}
              </div>
            ) : (
              <div className="price-visual-empty">
                当前 JSON 暂时无法解析，请切换到 JSON 修复格式。
              </div>
            )
          ) : (
            <textarea
              className="price-editor tl-scrollbar"
              spellCheck={false}
              value={props.pricesText}
              aria-label="模型价格 JSON"
              onChange={(event) => props.onPricesChange(event.target.value)}
              disabled={props.busy.prices}
              aria-invalid={!!props.pricesError}
              aria-describedby={props.pricesError ? 'price-editor-error' : undefined}
            />
          )}
          {props.pricesError && (
            <p className="form-error" id="price-editor-error">
              {props.pricesError}
            </p>
          )}
          <SettingsActionRow busy={pricesBusy}>
            <button
              className="primary-inline"
              type="button"
              onClick={props.onSavePrices}
              disabled={pricesBusy}
              aria-busy={pricesBusy || undefined}
              aria-label={savePricesLabel}
              title={savePricesLabel}
            >
              {pricesBusy && <RefreshCw className="h-4 w-4 animate-spin" />}
              {pricesBusy ? '保存中…' : '保存价格表'}
            </button>
          </SettingsActionRow>
          </div>
        </div>}
      </div>
      {modelsDevTarget && (
        <ModelsDevImportDialog
          modelKey={modelsDevTarget.modelKey}
          observedModel={modelsDevTarget.observedModel}
          tools={modelsDevTarget.tools}
          currentPrice={{
            input: typeof modelsDevTarget.config.input === 'number' ? modelsDevTarget.config.input : 1,
            output: typeof modelsDevTarget.config.output === 'number' ? modelsDevTarget.config.output : 3,
            cache_input: typeof modelsDevTarget.config.cache_input === 'number'
              ? modelsDevTarget.config.cache_input
              : (typeof modelsDevTarget.config.input === 'number' ? modelsDevTarget.config.input : 1) * 0.1,
            cache_write: typeof modelsDevTarget.config.cache_write === 'number'
              ? modelsDevTarget.config.cache_write
              : (typeof modelsDevTarget.config.input === 'number' ? modelsDevTarget.config.input : 1) * 1.25,
          }}
          pricesDirty={props.pricesDirty}
          saving={props.busy.prices}
          onClose={() => setModelsDevTarget(null)}
          onImport={props.onImportModelsDevPrice}
        />
      )}
    </SettingsSection>
  );
}

export default PricingSection;
