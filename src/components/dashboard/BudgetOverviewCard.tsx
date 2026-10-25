import { useMemo } from 'react';
import { RefreshCw, Settings, Wallet } from 'lucide-react';
import { useBudgetSettings, useBudgetStatus, type BudgetRule, type BudgetStatus } from '../../hooks/useBudget';
import { useT } from '../../i18n';
import { budgetReading, budgetRuleTitle } from '../settings/BudgetSection';

interface Reading {
  status: BudgetStatus | undefined;
  percent: number | null;
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

function readingFor(rule: BudgetRule, status: BudgetStatus | undefined, loaded: boolean): Reading {
  if (!loaded || !status || status.used === null || !finite(status.used)
    || status.used < 0 || !finite(status.percent) || status.percent < 0 || status.limit !== rule.limit) {
    return { status, percent: null };
  }
  return { status, percent: status.percent };
}

/**
 * 概览「预算」卡片：只读展示设置 › 预算提醒里启用的预算，进度与设置页同一口径。
 * 预算按本机统计，云端口径下也读本机，卡片标题上写明。
 */
export function BudgetOverviewCard({ scope, onOpenSettings }: { scope: 'local' | 'cloud'; onOpenSettings?: () => void }) {
  const t = useT();
  const { settings, loaded, loading: settingsLoading, error: settingsError, reload: reloadSettings } = useBudgetSettings();
  const { report, loading, refreshing, error: statusError, reload: reloadStatus } = useBudgetStatus(settings);
  const statusById = useMemo(() => new Map((report?.statuses ?? []).map(status => [status.ruleId, status])), [report]);
  const rules = settings.rules.filter(rule => rule.enabled);
  const statusUsable = report !== null && !statusError;
  return (
    <section className="panel budget-overview-card" aria-label={t('budget.overview.title')}>
      <div className="panel-header">
        <div className="panel-title">
          <span className="panel-icon" aria-hidden="true"><Wallet className="h-4 w-4" /></span>
          <h2>{t('budget.overview.title')}</h2>
          {scope === 'cloud' && <span className="budget-overview-scope">{t('budget.overview.cloudSource')}</span>}
        </div>
        {onOpenSettings && (
          <button type="button" className="ghost-inline budget-overview-action" onClick={onOpenSettings}>
            <Settings className="h-3.5 w-3.5" aria-hidden="true" />{t('budget.overview.openSettings')}
          </button>
        )}
      </div>
      <p className="budget-overview-source">{t('budget.overview.source')}</p>
      {!loaded ? <p className="budget-overview-empty" role="status">{t('budget.overview.loading')}</p>
        : settingsError ? <div className="budget-overview-failure" role="alert">
            <span>{settingsError}</span>
            <button type="button" className="ghost-inline budget-overview-action" onClick={reloadSettings}>
              <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />{t('budget.overview.retrySettings')}
            </button>
          </div>
        : settingsLoading ? <p className="budget-overview-empty" role="status">{t('budget.overview.loadingSettings')}</p>
        : rules.length === 0 ? <p className="budget-overview-empty">{t('budget.overview.empty')}</p>
          : <ul className="budget-overview-list">
            {rules.map(rule => {
              const reading = readingFor(rule, statusById.get(rule.id), statusUsable);
              const { status, percent } = reading;
              const available = status !== undefined && percent !== null && status.level !== 'unavailable';
              const capped = percent === null ? 0 : Math.min(100, Math.max(0, percent));
              const title = budgetRuleTitle(rule);
              const unavailable = statusUsable && status?.limit === rule.limit && status.level === 'unavailable';
              const readingText = available ? budgetReading(rule, status, true)
                : loading && !report ? budgetReading(rule, undefined)
                  : unavailable ? budgetReading(rule, status)
                  : status ? t('budget.overview.invalidStatus') : t('budget.overview.missingStatus');
              const levelText = available ? t(`budget.level.${status.level}`)
                : loading && !report ? t('budget.overview.loading') : t('budget.level.unavailable');
              return (
                <li key={rule.id} className="budget-overview-rule" data-level={available ? status.level : 'unavailable'}>
                  <div className="budget-overview-rule-head">
                    <span className="budget-overview-rule-title">{title}</span>
                    <strong className="budget-overview-level">{levelText}</strong>
                  </div>
                  <span className="budget-overview-reading">{readingText}</span>
                  {available ? (
                    <div className="budget-overview-meter" role="meter"
                      aria-label={t('budget.meterAria', { title })}
                      aria-valuemin={0} aria-valuemax={100}
                      aria-valuenow={capped} aria-valuetext={`${readingText} · ${levelText}`}>
                      <span style={{ width: `${capped}%` }} />
                    </div>
                  ) : (
                    <div className="budget-overview-unknown" aria-hidden="true" />
                  )}
                </li>
              );
            })}
          </ul>}
      {!settingsError && !settingsLoading && refreshing && <p className="budget-overview-status" role="status">{t('budget.overview.refreshing')}</p>}
      {!settingsError && !settingsLoading && statusError && rules.length > 0 && <div className="budget-overview-failure" role="alert">
        <span>{t('budget.overview.refreshFailed', { error: statusError })}</span>
        <button type="button" className="ghost-inline budget-overview-action" onClick={reloadStatus} disabled={loading}>
          <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />{t('budget.overview.retryStatus')}
        </button>
      </div>}
    </section>
  );
}
