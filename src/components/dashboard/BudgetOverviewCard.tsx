import { useMemo } from 'react';
import { Settings, Wallet } from 'lucide-react';
import { useBudgetSettings, useBudgetStatus } from '../../hooks/useBudget';
import { budgetReading, budgetRuleTitle } from '../settings/BudgetSection';

const LEVEL_LABELS = { ok: '正常', warn: '接近上限', over: '已超出', unavailable: '不可得' } as const;

/**
 * 概览「预算」卡片：只读展示设置 › 预算提醒里启用的预算，进度与设置页同一口径。
 * 预算按本机统计，云端口径下也读本机，卡片标题上写明。
 */
export function BudgetOverviewCard({ scope, onOpenSettings }: { scope: 'local' | 'cloud'; onOpenSettings?: () => void }) {
  const { settings, loaded, error: settingsError } = useBudgetSettings();
  const { report, error } = useBudgetStatus(settings);
  const statusById = useMemo(() => new Map((report?.statuses ?? []).map(status => [status.ruleId, status])), [report]);
  const rules = settings.rules.filter(rule => rule.enabled);
  return (
    <section className="panel budget-overview-card" aria-label="预算">
      <div className="panel-header">
        <div className="panel-title">
          <span className="panel-icon" aria-hidden="true"><Wallet className="h-4 w-4" /></span>
          <span>预算</span>
          {scope === 'cloud' && <span className="budget-overview-scope">按本机统计</span>}
        </div>
        {onOpenSettings && (
          <button type="button" className="ghost-inline" onClick={onOpenSettings}>
            <Settings className="h-3.5 w-3.5" aria-hidden="true" />设置预算
          </button>
        )}
      </div>
      {!loaded ? <p className="budget-overview-empty">读取中…</p>
        : settingsError ? <p className="budget-overview-error" role="alert">{settingsError}，暂时无法显示预算。</p>
        : rules.length === 0 ? <p className="budget-overview-empty">还没有启用的预算。在设置 › 预算提醒里新增一条，例如「本月 · 全部用量 · 预估费用 $50」。</p>
          : <ul className="budget-overview-list">
            {rules.map(rule => {
              const status = statusById.get(rule.id);
              const percent = status?.percent !== null && status?.percent !== undefined ? Math.min(100, Math.max(0, status.percent)) : 0;
              const title = budgetRuleTitle(rule);
              return (
                <li key={rule.id} className="budget-overview-rule" data-level={status?.level ?? 'ok'}>
                  <div className="budget-overview-rule-head">
                    <span className="budget-overview-rule-title">{title}</span>
                    {status && <strong className="budget-overview-level">{LEVEL_LABELS[status.level]}</strong>}
                  </div>
                  <span className="budget-overview-reading">{budgetReading(rule, status)}</span>
                  <div className="budget-overview-meter" role="meter" aria-label={`${title}已用比例`}
                    aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent)}>
                    <span style={{ width: `${percent}%` }} />
                  </div>
                </li>
              );
            })}
          </ul>}
      {error && rules.length > 0 && <p className="budget-overview-error" role="alert">{error}</p>}
    </section>
  );
}
