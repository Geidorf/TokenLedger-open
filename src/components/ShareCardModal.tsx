import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Check, Copy, Download, FileText, Image as ImageIcon, ShieldCheck, X } from 'lucide-react';
import '../styles/shareCardModal.css';
import { TokenLedgerIcon } from './brand/TokenLedgerIcon';
import type { CustomDateRange, DataScope, RangeKey, StatsData } from '../types';
import type { ShareLayoutKey } from '../utils/shareCardRenderer';
import { formatEstimatedUsd, formatNum, formatTokens } from '../utils/format';
import { buildShareSummary, COSTS_HIDDEN_NOTE, SHARE_DATA_UNAVAILABLE } from '../utils/shareSummary';
import { downloadVisualDigest } from '../utils/reportExport';
import {
  SHARE_LAYOUTS,
  copyShareCardToClipboard,
  downloadShareCardImage,
  ensureShareCardAssetsReady,
  renderShareCardToCanvas,
  shareCardCostFacts,
} from '../utils/shareCardRenderer';

interface ShareCardModalProps {
  isOpen: boolean;
  onClose: () => void;
  stats: StatsData;
  range: RangeKey;
  /** range === 'custom' 时的日期闭区间；仅用于「导出 HTML 简报」的标题与文件名（T10.163）。 */
  customRange?: CustomDateRange | null;
  scope: DataScope;
  appVersion?: string;
  onNotify?: (type: 'info' | 'success' | 'warning' | 'error', message: string) => void;
}

function buildSharePreviewAriaLabel({
  stats,
  range,
  scope,
  layout,
  hideCosts,
}: Pick<ShareCardModalProps, 'stats' | 'range' | 'scope'> & {
  layout: ShareLayoutKey;
  hideCosts: boolean;
}): string {
  const summary = buildShareSummary({ stats, range, scope, hideCosts });
  const layoutName = SHARE_LAYOUTS[layout].name;
  // T10.154 D55：可访问摘要读全称，不可得不读成 $0。
  const costLabel = hideCosts
    ? COSTS_HIDDEN_NOTE
    : summary.totalCostUsd === null
      ? '预估费用不可得'
      : `预估费用 ${formatEstimatedUsd(summary.totalCostUsd)}`;
  const boundaryNotes = summary.boundaryNotes.filter((note) => note !== COSTS_HIDDEN_NOTE);
  const parts = [
    `${layoutName}，${summary.title}`,
    `${summary.periodLabel}，${summary.sourceLabel}`,
    `有效 Token ${formatTokens(summary.effectiveTokens)}，${formatNum(summary.totalRequests)} 条记录`,
    costLabel,
  ];
  if (boundaryNotes.length > 0) parts.push(`提示：${boundaryNotes.join('、')}`);
  return `${parts.join('。')}。`;
}

export function ShareCardModal({
  isOpen,
  onClose,
  stats,
  range,
  customRange = null,
  scope,
  appVersion,
  onNotify,
}: ShareCardModalProps) {
  const [layout, setLayout] = useState<ShareLayoutKey>('scorecard');
  const [hideCosts, setHideCosts] = useState(true);
  const [copied, setCopied] = useState(false);
  const [exportAction, setExportAction] = useState<'copy' | 'download' | null>(null);
  const [previewState, setPreviewState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [previewError, setPreviewError] = useState('字体、品牌或艺术底图加载失败。');
  const [previewRetry, setPreviewRetry] = useState(0);
  const exporting = exportAction !== null;
  const layoutKeys = Object.keys(SHARE_LAYOUTS) as ShareLayoutKey[];
  const layoutButtonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const previewContainerRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!isOpen) {
      setCopied(false);
      setExportAction(null);
      setPreviewState('loading');
      return;
    }

    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButtonRef.current?.focus();
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key === 'Tab') {
        const surface = closeButtonRef.current?.closest('.share-modal-surface');
        const candidates = Array.from(surface?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) || []).filter((element) => {
          // The mobile footer keeps a second copy of the privacy control in
          // the DOM so the same decision stays beside the export actions on
          // small screens. CSS hides that copy on desktop, but hidden
          // controls must never enter the modal's keyboard loop.
          const style = window.getComputedStyle(element);
          return !element.hidden
            && style.display !== 'none'
            && style.visibility !== 'hidden';
        });
        // jsdom has no layout engine, so every client rect is empty there.
        // Only apply the geometry-based hidden check when this surface has at
        // least one measurable rect; otherwise the semantic/CSS checks above
        // still provide a usable keyboard loop for unit and embedded-WebView
        // environments without layout metrics.
        const hasLayoutMetrics = candidates.some((element) => element.getClientRects().length > 0);
        const focusable = hasLayoutMetrics
          ? candidates.filter((element) => element.getClientRects().length > 0)
          : candidates;
        if (focusable.length === 0) return;
        const currentIndex = focusable.indexOf(document.activeElement as HTMLElement);
        const nextIndex = e.shiftKey
          ? (currentIndex <= 0 ? focusable.length - 1 : currentIndex - 1)
          : (currentIndex + 1) % focusable.length;
        e.preventDefault();
        focusable[nextIndex].focus();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      previouslyFocused?.focus();
    };
  }, [isOpen, onClose]);

  // Preview and export share the exact same Canvas renderer.
  useEffect(() => {
    if (!isOpen || !previewContainerRef.current) return;
    let cancelled = false;
    setPreviewState('loading');
    previewContainerRef.current.innerHTML = '';
    const drawPreview = async () => {
      try {
        await ensureShareCardAssetsReady(layout);
        if (cancelled || !previewContainerRef.current) return;
        const canvas = renderShareCardToCanvas({
          stats,
          range,
          scope,
          layout,
          hideCosts,
          appVersion,
        });
        canvas.className = 'share-modal-canvas-preview';
        canvas.setAttribute('role', 'img');
        canvas.setAttribute('aria-label', buildSharePreviewAriaLabel({ stats, range, scope, layout, hideCosts }));
        previewContainerRef.current.innerHTML = '';
        previewContainerRef.current.appendChild(canvas);
        setPreviewState('ready');
      } catch (error) {
        if (!cancelled) {
          const dataUnavailable = error instanceof Error && error.message === SHARE_DATA_UNAVAILABLE;
          setPreviewState('error');
          setPreviewError(dataUnavailable ? SHARE_DATA_UNAVAILABLE : '字体、品牌或艺术底图加载失败。');
          onNotify?.('error', dataUnavailable ? SHARE_DATA_UNAVAILABLE : '海报资源加载失败，请重试');
        }
      }
    };
    void drawPreview();
    return () => { cancelled = true; };
  }, [isOpen, stats, range, scope, layout, hideCosts, appVersion, onNotify, previewRetry]);

  if (!isOpen) return null;

  // T10.154 D56：按当前布局写这张图实际画了哪些费用，取代原先笼统的提示；简报沿用同一开关。
  let currentSummary: ReturnType<typeof buildShareSummary> | null = null;
  try { currentSummary = buildShareSummary({ stats, range, scope, hideCosts }); } catch { /* Invalid core values must not crash the dialog. */ }
  const posterCostFacts = hideCosts || !currentSummary ? [] : shareCardCostFacts(layout, currentSummary);
  const exposedCostNote = `${posterCostFacts.length > 0 ? `这张图包含：${posterCostFacts.join('、')}` : '这张图不含费用'}；HTML 简报包含预估费用`;

  const handleCopy = async () => {
    setExportAction('copy');
    try {
      const success = await copyShareCardToClipboard({
        stats,
        range,
        scope,
        layout,
        hideCosts,
        appVersion,
      });
      if (success) {
        setCopied(true);
        onNotify?.('success', '战报图片已复制到剪贴板，可直接粘贴发送');
        setTimeout(() => setCopied(false), 2500);
      } else {
        onNotify?.('warning', '复制到剪贴板失败，请使用保存图片');
      }
    } catch {
      onNotify?.('warning', '复制到剪贴板失败，请重试或保存图片');
    } finally {
      setExportAction(null);
    }
  };

  const handleDownload = async () => {
    setExportAction('download');
    try {
      await downloadShareCardImage({
        stats,
        range,
        scope,
        layout,
        hideCosts,
        appVersion,
      });
      // <a download> 只能确认已发起，无法获知下载目录写入是否成功。
      onNotify?.('success', '已发起高清周期总结 PNG 图片下载，请在下载文件夹确认');
    } catch {
      onNotify?.('error', '图片生成失败，已保留当前选择，请重试');
    } finally {
      setExportAction(null);
    }
  };

  // Q11：可留档的 HTML 简报现在从分享弹窗直接导出，沿用同一份 stats/range/scope
  // 与当前隐私开关，不再要求用户先去设置页找入口（原入口已从 DataHelpSection 移除）。
  const handleExportDigest = () => {
    const exported = downloadVisualDigest({
      stats,
      range,
      customRange,
      layout,
      scope,
      appVersion: appVersion ?? '',
      hideCosts,
    });
    onNotify?.(
      exported ? 'success' : 'error',
      exported ? '已发起 HTML 简报下载，请在下载文件夹确认' : 'HTML 简报导出失败，请重试',
    );
  };

  const handleLayoutKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const currentIndex = layoutKeys.indexOf(layout);
    if (currentIndex < 0) return;

    let nextIndex: number | null = null;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      nextIndex = (currentIndex + 1) % layoutKeys.length;
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      nextIndex = (currentIndex - 1 + layoutKeys.length) % layoutKeys.length;
    } else if (event.key === 'Home') {
      nextIndex = 0;
    } else if (event.key === 'End') {
      nextIndex = layoutKeys.length - 1;
    }
    if (nextIndex === null || nextIndex === currentIndex) return;

    event.preventDefault();
    setLayout(layoutKeys[nextIndex]);
    requestAnimationFrame(() => layoutButtonRefs.current[nextIndex]?.focus());
  };

  const renderPrivacyToggle = (className = '') => (
    <button
      type="button"
      role="switch"
      aria-checked={hideCosts}
      className={`share-privacy-toggle ${className} ${hideCosts ? 'is-active' : ''}`.trim()}
      onClick={() => setHideCosts((value) => !value)}
      disabled={exporting}
    >
      <ShieldCheck className="h-4 w-4" aria-hidden="true" />
      <span>
        <strong>隐藏费用</strong>
        <small>预览、复制、保存与 HTML 简报导出始终使用同一设置</small>
      </span>
      <span className="share-privacy-state">{hideCosts ? '已开启' : '已关闭'}</span>
    </button>
  );

  return (
    <div
      className="share-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="share-modal-title"
      aria-busy={exporting || undefined}
    >
      <div className="share-modal-surface">
        <header className="share-modal-header">
          <div className="share-modal-title-wrap">
            <div className="share-modal-icon">
              <TokenLedgerIcon className="h-4 w-4" />
            </div>
            <div>
              <h2 id="share-modal-title" className="share-modal-title">周期总结海报</h2>
            </div>
          </div>
          <button ref={closeButtonRef} className="icon-command share-modal-close" type="button" onClick={onClose} aria-label="关闭弹窗">
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="share-modal-body">
          {/* Left Canvas Preview */}
          <div className="share-modal-preview-wrapper" aria-busy={previewState === 'loading'}>
            <div className="share-modal-preview-stage" ref={previewContainerRef}>
              {/* Canvas dynamically attached here */}
            </div>
            {previewState === 'loading' && (
              <div className="share-preview-state" role="status" aria-live="polite">
                正在生成海报预览…
              </div>
            )}
            {previewState === 'error' && (
              <div className="share-preview-state share-preview-error" role="alert">
                <strong>海报预览暂不可用</strong>
                <span>{previewError}</span>
                <button
                  type="button"
                  className="secondary-action share-preview-retry"
                  onClick={() => setPreviewRetry((value) => value + 1)}
                  disabled={exporting}
                >
                  重试生成预览
                </button>
              </div>
            )}
          </div>

          {/* Right Controls */}
          <div className="share-modal-controls">
            <div className="share-modal-section">
              <span className="share-modal-label">海报布局</span>
              <div className="share-layout-selector" role="radiogroup" aria-label="海报布局">
                {layoutKeys.map((key, index) => {
                  const item = SHARE_LAYOUTS[key];
                  const active = layout === key;
                  return (
                    <button
                      key={key}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      tabIndex={active ? 0 : -1}
                      className={`share-layout-btn ${active ? 'is-active' : ''} is-${key}`}
                      onClick={() => setLayout(key)}
                      onKeyDown={handleLayoutKeyDown}
                      ref={(element) => { layoutButtonRefs.current[index] = element; }}
                      disabled={exporting}
                    >
                      <span className="share-layout-index" aria-hidden="true">{index + 1}</span>
                      <span className="share-layout-copy">
                        <strong>{item.name}</strong>
                        <small>{item.description}</small>
                      </span>
                      {active && <Check className="h-4 w-4" aria-hidden="true" />}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="share-modal-section share-privacy-section">
              <span className="share-modal-label">隐私</span>
              {renderPrivacyToggle()}
            </div>

            <div className="share-modal-section share-modal-tip">
              <ImageIcon className="h-4 w-4 text-accent" />
              <span>不含账号、设备或会话标识；复制失败时可保存图片。</span>
            </div>
          </div>
        </div>
        <footer className="share-modal-footer">
          {exportAction && (
            <p className="share-export-status" role="status" aria-live="polite">
              {exportAction === 'copy' ? '正在复制图片…' : '正在生成高清图片…'}
            </p>
          )}
          <p
            id="share-privacy-export-summary"
            className={`share-export-privacy ${hideCosts ? 'is-safe' : 'is-exposed'}`}
            aria-live="polite"
          >
            <ShieldCheck className="h-4 w-4" aria-hidden="true" />
            <span>{hideCosts ? '分享与导出前：费用已隐藏' : exposedCostNote}</span>
          </p>
          <div className="share-privacy-mobile">
            {renderPrivacyToggle('share-privacy-toggle-footer')}
          </div>
          <div className="share-modal-actions">
            <button
              type="button"
              className="primary-action share-action-copy"
              onClick={handleCopy}
              disabled={exporting || !currentSummary}
              aria-busy={exportAction === 'copy'}
              aria-describedby="share-privacy-export-summary"
            >
              {copied ? <Check className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
              <span>{copied ? '已复制到剪贴板' : exportAction === 'copy' ? '正在复制图片…' : '复制图片'}</span>
            </button>

            <button
              type="button"
              className="secondary-action share-action-download"
              onClick={handleDownload}
              disabled={exporting || !currentSummary}
              aria-busy={exportAction === 'download'}
              aria-describedby="share-privacy-export-summary"
            >
              <Download className="h-4 w-4" />
              <span>{exportAction === 'download' ? '正在生成高清图片…' : '保存高清图片'}</span>
            </button>

            <button
              type="button"
              className="secondary-action share-action-digest"
              onClick={handleExportDigest}
              disabled={exporting || !currentSummary}
              aria-describedby="share-privacy-export-summary"
            >
              <FileText className="h-4 w-4" />
              <span>导出 HTML 简报</span>
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

export default ShareCardModal;
