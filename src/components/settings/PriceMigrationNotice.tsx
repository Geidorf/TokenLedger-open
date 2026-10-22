import { createContext, useContext, useEffect, useId, useRef, useState } from 'react';
import { ChevronDown, History } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import type {
  PriceMigrationChange,
  PriceMigrationClearedModel,
  PriceMigrationNotice as PriceMigrationNoticeData,
} from '../../types';
import { formatLocalDateTime } from '../../utils/format';
import '../../styles/price-migration-notice.css';

const FIELD_LABELS: Record<string, string> = {
  input: '输入',
  output: '输出',
  cache_input: '缓存读',
  cache_write: '缓存写',
};

/** Price changes listed before 「显示全部」. */
const VISIBLE_CHANGES = 5;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isChange(value: unknown): value is PriceMigrationChange {
  return isRecord(value)
    && typeof value.model === 'string'
    && typeof value.field === 'string'
    && isFiniteNumber(value.previous)
    && (value.current === null || isFiniteNumber(value.current));
}

function isClearedModel(value: unknown): value is PriceMigrationClearedModel {
  return isRecord(value)
    && typeof value.model === 'string'
    && Array.isArray(value.fields)
    && value.fields.every((field) => typeof field === 'string')
    && typeof value.wholeModel === 'boolean';
}

/**
 * What `get_price_migration_notice` returned, checked: anything malformed is
 * treated as no notice rather than rendered with made-up numbers (GLB-01).
 * The counts must also add up to the lists, so a record edited by hand cannot
 * put 「删除了 0 个型号的 12 项价格」 on screen (T10.189 review P3-2): whole
 * non-negative counts, one model per cleared entry, one price per cleared
 * field, and each changed price once and among the cleared ones.
 */
export function parsePriceMigrationNotice(value: unknown): PriceMigrationNoticeData | null {
  if (!isRecord(value)) return null;
  const { id, migratedAt, backupFile, backupDir, modelsCleared, fieldsCleared, cleared, changed } = value;
  if (typeof id !== 'string' || !/^[0-9a-f]{64}$/.test(id)) return null;
  if (typeof backupFile !== 'string' || backupFile === '' || typeof backupDir !== 'string') return null;
  if (!isCount(modelsCleared) || !isCount(fieldsCleared) || fieldsCleared === 0) return null;
  if (!Array.isArray(cleared) || !cleared.every(isClearedModel)) return null;
  if (!Array.isArray(changed) || !changed.every(isChange)) return null;
  if (modelsCleared !== cleared.length) return null;
  if (fieldsCleared !== cleared.reduce((sum, model) => sum + model.fields.length, 0)) return null;
  if (new Set(changed.map((change) => `${change.model}\u0000${change.field}`)).size !== changed.length) return null;
  const isCleared = (change: PriceMigrationChange) =>
    cleared.some((model) => model.model === change.model && model.fields.includes(change.field));
  if (!changed.every(isCleared)) return null;
  return {
    id,
    migratedAt: typeof migratedAt === 'string' ? migratedAt : '',
    backupFile,
    backupDir,
    modelsCleared,
    fieldsCleared,
    cleared,
    changed,
  };
}

/** A rate without the float noise an estimate carries (`0.15000000000000002`). */
function formatRate(value: number): string {
  return String(Number(value.toPrecision(6)));
}

/**
 * Tells the settings page whether a notice is showing, so its directory can
 * mark 「模型价格」 with 「已整理」 until the notice is dismissed (T10.202).
 * Outside the settings page nothing listens.
 */
export const PriceMigrationNoticeOpenContext = createContext<(open: boolean) => void>(() => {});

/**
 * One-time notice at the top of 设置 → 模型价格 after a price override file
 * with the traits of an older version was cleaned up (T10.189, U-5 and U-6):
 * how many prices went, which ones now cost something else, where the backup
 * is and how to get a value back. The wording holds whatever caused the
 * cleanup, an upgrade or a file copied back or edited by hand (T10.202).
 * Dismissing it is kept by the backend for this migration.
 */
export function PriceMigrationNotice() {
  const [notice, setNotice] = useState<PriceMigrationNoticeData | null>(null);
  const [showAllChanges, setShowAllChanges] = useState(false);
  const [dismissing, setDismissing] = useState(false);
  const [dismissError, setDismissError] = useState('');
  const reportOpen = useContext(PriceMigrationNoticeOpenContext);
  const rootRef = useRef<HTMLElement>(null);
  const titleId = useId();
  const changesLabelId = useId();
  const changesId = useId();

  useEffect(() => {
    reportOpen(notice !== null);
  }, [notice, reportOpen]);

  useEffect(() => () => reportOpen(false), [reportOpen]);

  useEffect(() => {
    let cancelled = false;
    invoke<unknown>('get_price_migration_notice')
      .then((value) => {
        if (!cancelled) setNotice(parsePriceMigrationNotice(value));
      })
      .catch(() => {
        // No notice to show: the price settings work the same without it.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!notice) return null;

  const dismiss = async () => {
    if (dismissing) return;
    setDismissing(true);
    setDismissError('');
    try {
      await invoke('dismiss_price_migration_notice', { id: notice.id });
      // The button goes away with the notice: move focus to the price section
      // first so keyboard and screen reader users are not dropped to the page.
      rootRef.current?.closest<HTMLElement>('section[tabindex]')?.focus({ preventScroll: true });
      setNotice(null);
    } catch (error) {
      setDismissError(String(error));
    } finally {
      setDismissing(false);
    }
  };

  const changes = notice.changed;
  // Only prices count: a value that was not a number is neither cleared nor
  // changed (the backend leaves it out of both), so the rest kept its price.
  const unchanged = notice.fieldsCleared - changes.length;
  const visibleChanges = showAllChanges ? changes : changes.slice(0, VISIBLE_CHANGES);
  const migratedAt = notice.migratedAt ? formatLocalDateTime(notice.migratedAt) : '';

  return (
    <section className="price-migration-notice" aria-labelledby={titleId} ref={rootRef}>
      <span className="price-migration-notice-icon" aria-hidden="true">
        <History className="h-4 w-4" />
      </span>
      <div className="price-migration-notice-body">
        <h3 className="price-migration-notice-title" id={titleId}>已整理你保存过的价格</h3>
        <p>
          {`旧版本保存价格表时，会把内置价和估算价一起写进自定义价格文件。带着这种痕迹的价格文件（旧版本写的，或从别处拷回、手工改过的）会整理一次，只保留你改过的价格。这次删除了 ${notice.modelsCleared} 个型号的 ${notice.fieldsCleared} 项价格：它们与某一版内置价或估算价相同，或者所在的行仍带“待核价”标记。`}
        </p>
        {changes.length > 0 ? (
          <>
            <p id={changesLabelId}>其中 {changes.length} 项删除后价格有变化（单位：$/百万 Token）：</p>
            <ul className="price-migration-notice-changes" id={changesId} aria-labelledby={changesLabelId}>
              {visibleChanges.map((change) => (
                <li key={`${change.model}\u0000${change.field}`}>
                  <span className="price-migration-notice-model">{change.model}</span>
                  <span>{FIELD_LABELS[change.field] ?? change.field}</span>
                  <span className="price-migration-notice-rate">
                    {formatRate(change.previous)}
                    <span aria-hidden="true"> → </span>
                    <span className="sr-only">改为</span>
                    {change.current === null ? '按工具兜底价估算' : formatRate(change.current)}
                  </span>
                </li>
              ))}
            </ul>
            {changes.length > VISIBLE_CHANGES && (
              <button
                className="ghost-inline price-migration-notice-more"
                type="button"
                aria-expanded={showAllChanges}
                aria-controls={changesId}
                onClick={() => setShowAllChanges((expanded) => !expanded)}
              >
                {showAllChanges ? `只看前 ${VISIBLE_CHANGES} 项` : `显示全部 ${changes.length} 项`}
                <ChevronDown className="h-4 w-4 price-migration-notice-chevron" aria-hidden="true" />
              </button>
            )}
            {unchanged > 0 && <p>其余 {unchanged} 项与现在的价格相同，删除后价格不变。</p>}
          </>
        ) : (
          <p>这些价格都与现在的价格相同，删除后价格没有变化。</p>
        )}
        <p>
          {'如果其中有你特意填写的价格：用文本编辑器打开下面的备份文件对照，再展开下方的价格表重新填写并保存。不要把备份改名回 prices.json，那样会被再次整理。'}
        </p>
        <dl className="price-migration-notice-facts">
          <dt>备份文件</dt>
          <dd><code>{notice.backupFile}</code></dd>
          <dt>所在目录</dt>
          <dd><code>{notice.backupDir}</code></dd>
          {migratedAt && (
            <>
              <dt>整理时间</dt>
              <dd>{migratedAt}</dd>
            </>
          )}
        </dl>
        {dismissError && (
          <p className="price-migration-notice-error" role="alert">
            没能记住“不再提示”（{dismissError}）。可以再点一次；价格不受影响。
          </p>
        )}
        <div className="price-migration-notice-actions">
          <button
            className="secondary-inline"
            type="button"
            onClick={() => void dismiss()}
            disabled={dismissing}
            aria-busy={dismissing || undefined}
          >
            {dismissing ? '正在关闭…' : '知道了，不再提示'}
          </button>
        </div>
      </div>
    </section>
  );
}

export default PriceMigrationNotice;
