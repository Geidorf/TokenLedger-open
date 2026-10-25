import { useEffect, useId, useMemo, useState } from 'react';
import { Bell, Pencil, Plus, Smartphone, Trash2, Wallet } from 'lucide-react';
import {
  BUDGET_METRICS,
  BUDGET_METRIC_LABELS,
  BUDGET_PERIODS,
  BUDGET_PERIOD_LABELS,
  BUDGET_SCOPE_KINDS,
  BUDGET_SCOPE_LABELS,
  BUDGET_WARN_PERCENTS,
  EMPTY_BUDGET_CHOICES,
  MAX_BUDGET_RULES,
  newBudgetRuleId,
  OFF_PHONE_SYNC,
  useBudgetSettings,
  useBudgetStatus,
  type BudgetMetric,
  type BudgetPeriod,
  type BudgetRule,
  type BudgetScopeKind,
  type BudgetStatus,
  type PhoneSyncStatus,
} from '../../hooks/useBudget';
import { formatEstimatedUsd, formatTokens } from '../../utils/format';
import { toolDisplayName } from '../../utils/toolDisplayName';
import {
  SettingsActionRow,
  SettingsCard,
  SettingsGroup,
  SettingsRow,
  SettingsSection,
  SettingsToggleRow,
} from './SettingsPrimitives';
import { AlertWebhookCard } from './AlertWebhookCard';
import '../../styles/budget.css';
import { getLang, localized, t, useLang } from '../../i18n';

interface Draft {
  id: string | null;
  period: BudgetPeriod;
  metric: BudgetMetric;
  scopeKind: BudgetScopeKind;
  scopeId: string;
  limit: string;
  warnPercent: number;
}

const EMPTY_DRAFT: Draft = {
  id: null,
  period: 'month',
  metric: 'cost',
  scopeKind: 'all',
  scopeId: '',
  limit: '',
  warnPercent: 80,
};

export function budgetScopeName(rule: Pick<BudgetRule, 'scopeKind' | 'scopeId'>): string {
  if (rule.scopeKind === 'all') return BUDGET_SCOPE_LABELS.all;
  const name = rule.scopeKind === 'tool' ? toolDisplayName(rule.scopeId) : rule.scopeId;
  return `${BUDGET_SCOPE_LABELS[rule.scopeKind]} · ${name}`;
}

/** 「同步到手机」开关下面的说明：开着时说清现在有没有送到云端。 */
export function phoneSyncHint(enabled: boolean, status: PhoneSyncStatus): string {
  const base = t('budget.phone.base');
  if (!enabled) return base;
  switch (status.state) {
    case 'ok':
      return status.lastPublishedAt
        ? t('budget.phone.okAt', { time: new Date(status.lastPublishedAt).toLocaleTimeString(getLang() === 'en' ? 'en-US' : 'zh-CN', { hour: '2-digit', minute: '2-digit' }) })
        : t('budget.phone.ok');
    case 'signed-out':
      return t('budget.phone.signedOut');
    case 'not-deployed':
      return t('budget.phone.notDeployed');
    case 'error':
      return t('budget.phone.error', { error: status.error ?? t('budget.phone.errorUnknown') });
    default:
      return t('budget.phone.pending');
  }
}

export function budgetRuleTitle(rule: BudgetRule): string {
  return `${BUDGET_PERIOD_LABELS[rule.period]} · ${budgetScopeName(rule)} · ${BUDGET_METRIC_LABELS[rule.metric]}`;
}

function formatAmount(metric: BudgetMetric, value: number | null): string {
  return metric === 'cost' ? formatEstimatedUsd(value) : formatTokens(value);
}

/** 读数文案：已用 / 上限 · 百分比；读不到时说明原因，不当成 0。 */
export function budgetReading(rule: BudgetRule, status: BudgetStatus | undefined, uncappedPercent = false): string {
  if (!rule.enabled) return t('budget.reading.disabled', { limit: formatAmount(rule.metric, rule.limit) });
  if (!status) return t('budget.reading.loading', { limit: formatAmount(rule.metric, rule.limit) });
  if (status.level === 'unavailable' || status.used === null) {
    const reason = rule.scopeKind === 'provider'
      ? t('budget.reason.provider')
      : rule.metric === 'cost' ? t('budget.reason.unpriced') : t('budget.reason.unreadable');
    return t('budget.reading.unavailable', { limit: formatAmount(rule.metric, rule.limit), reason });
  }
  const percent = Math.floor(status.percent ?? 0);
  const shown = percent > 999 && !uncappedPercent ? '>999%' : `${percent}%`;
  return t('budget.reading.used', { used: formatAmount(rule.metric, status.used), limit: formatAmount(rule.metric, rule.limit), percent: shown });
}

const LEVEL_LABELS = localized<BudgetStatus['level']>({
  ok: 'budget.level.ok',
  warn: 'budget.level.warn',
  over: 'budget.level.over',
  unavailable: 'budget.level.unavailable',
});

function parseLimit(metric: BudgetMetric, raw: string): number | null {
  const value = Number(raw.trim());
  if (!raw.trim() || !Number.isFinite(value) || value <= 0) return null;
  if (metric === 'tokens') return value >= 1 ? Math.round(value) : null;
  return value;
}

/**
 * 设置 › 预算提醒。预算按今日 / 本周（周一起）/ 本月的日历周期，只看已发生的用量，
 * 与看板同一份本机统计；接近（默认 80%）与超出各提醒一次，托盘提示同时显示。
 */
export function BudgetSection() {
  useLang();
  const { settings, loaded, saving, error, save } = useBudgetSettings();
  const { report, error: statusError, reload } = useBudgetStatus(settings);
  const phoneState = report?.phoneSync.state ?? 'off';
  // 打开同步后发布在后台进行，几秒后再读一次状态，不让说明停在「正在准备」。
  useEffect(() => {
    if (!settings.syncToPhone || phoneState !== 'off') return undefined;
    const timer = setTimeout(reload, 3000);
    return () => clearTimeout(timer);
  }, [settings.syncToPhone, phoneState, reload]);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [formError, setFormError] = useState('');
  const listId = useId();
  const disabled = !loaded || saving;
  const choices = report?.choices ?? EMPTY_BUDGET_CHOICES;
  const statusById = useMemo(
    () => new Map((report?.statuses ?? []).map((status) => [status.ruleId, status])),
    [report],
  );
  const suggestions = draft.scopeKind === 'tool'
    ? choices.tools
    : draft.scopeKind === 'model'
      ? choices.models
      : draft.scopeKind === 'provider' ? choices.providers : [];
  const full = settings.rules.length >= MAX_BUDGET_RULES && draft.id === null;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const limit = parseLimit(draft.metric, draft.limit);
    if (limit === null) {
      setFormError(draft.metric === 'tokens' ? t('budget.form.minTokens') : t('budget.form.positive'));
      return;
    }
    const scopeId = draft.scopeKind === 'all' ? '' : draft.scopeId.trim();
    if (draft.scopeKind !== 'all' && !scopeId) {
      setFormError(t('budget.form.missingScope', { scope: BUDGET_SCOPE_LABELS[draft.scopeKind] }));
      return;
    }
    setFormError('');
    const rule: BudgetRule = {
      id: draft.id ?? newBudgetRuleId(),
      enabled: true,
      period: draft.period,
      metric: draft.metric,
      scopeKind: draft.scopeKind,
      scopeId,
      limit,
      warnPercent: draft.warnPercent,
    };
    const rules = draft.id
      ? settings.rules.map((item) => (item.id === draft.id ? { ...rule, enabled: item.enabled } : item))
      : [...settings.rules, rule];
    if (await save({ ...settings, rules })) setDraft(EMPTY_DRAFT);
  };

  const edit = (rule: BudgetRule) => {
    setFormError('');
    setDraft({
      id: rule.id,
      period: rule.period,
      metric: rule.metric,
      scopeKind: rule.scopeKind,
      scopeId: rule.scopeId,
      limit: String(rule.limit),
      warnPercent: rule.warnPercent,
    });
  };

  return (
    <SettingsSection id="budget" title={t('budget.title')}>
      <SettingsCard title={t('budget.notify.card')}>
        <SettingsGroup>
          <SettingsToggleRow
            label={t('budget.notify.label')}
            hint={t('budget.notify.hint')}
            icon={Bell}
            checked={settings.notify}
            disabled={disabled}
            busy={saving}
            onChange={(notify) => void save({ ...settings, notify })}
          />
          <SettingsToggleRow
            label={t('budget.phone.label')}
            hint={phoneSyncHint(settings.syncToPhone, report?.phoneSync ?? OFF_PHONE_SYNC)}
            icon={Smartphone}
            checked={settings.syncToPhone}
            disabled={disabled}
            busy={saving}
            onChange={(syncToPhone) => void save({ ...settings, syncToPhone })}
          />
          {error && <p className="settings-error" role="alert">{error}</p>}
        </SettingsGroup>
      </SettingsCard>

      <SettingsCard
        title={t('budget.list.title')}
        description={t('budget.list.description')}
      >
        <SettingsGroup>
          {settings.rules.length === 0 && (
            <SettingsRow label={t('budget.empty.label')} hint={t('budget.empty.hint')} icon={Wallet}>
              <span />
            </SettingsRow>
          )}
          {settings.rules.map((rule) => {
            const status = statusById.get(rule.id);
            const level = rule.enabled ? status?.level ?? 'ok' : 'ok';
            const percent = rule.enabled && status?.percent !== null && status?.percent !== undefined
              ? Math.min(100, Math.max(0, status.percent))
              : 0;
            const title = budgetRuleTitle(rule);
            return (
              <div key={rule.id} className="budget-rule" data-level={level} data-enabled={rule.enabled}>
                <SettingsRow label={title} hint={budgetReading(rule, status)} icon={Wallet}>
                  {rule.enabled && status && <strong className="budget-rule-level">{LEVEL_LABELS[status.level]}</strong>}
                  <div className="settings-inline-actions">
                    <button
                      type="button"
                      className="secondary-inline"
                      aria-pressed={rule.enabled}
                      disabled={disabled}
                      onClick={() => void save({
                        ...settings,
                        rules: settings.rules.map((item) => (item.id === rule.id ? { ...item, enabled: !item.enabled } : item)),
                      })}
                    >
                      {rule.enabled ? t('budget.disable') : t('budget.enable')}
                    </button>
                    <button type="button" className="secondary-inline" disabled={disabled} onClick={() => edit(rule)} aria-label={t('budget.editAria', { title })} title={t('budget.edit')}>
                      <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className="secondary-inline"
                      disabled={disabled}
                      aria-label={t('budget.deleteAria', { title })}
                      title={t('budget.delete')}
                      onClick={() => {
                        if (draft.id === rule.id) setDraft(EMPTY_DRAFT);
                        void save({ ...settings, rules: settings.rules.filter((item) => item.id !== rule.id) });
                      }}
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  </div>
                </SettingsRow>
                <div
                  className="budget-rule-meter"
                  role="meter"
                  aria-label={t('budget.meterAria', { title })}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(percent)}
                >
                  <span style={{ width: `${percent}%` }} />
                </div>
              </div>
            );
          })}
          {statusError && settings.rules.length > 0 && <p className="settings-error" role="alert">{statusError}</p>}
        </SettingsGroup>
      </SettingsCard>

      <SettingsCard title={draft.id ? t('budget.form.editTitle') : t('budget.form.addTitle')}>
        <form onSubmit={(event) => void submit(event)}>
          <SettingsGroup>
            <SettingsRow label={t('budget.form.scopeLabel')} hint={t('budget.form.scopeHint')} icon={Plus} wideControl>
              <div className="budget-form-fields">
                <select
                  className="settings-select"
                  aria-label={t('budget.form.periodAria')}
                  value={draft.period}
                  onChange={(event) => setDraft({ ...draft, period: event.target.value as BudgetPeriod })}
                >
                  {BUDGET_PERIODS.map((period) => <option key={period} value={period}>{BUDGET_PERIOD_LABELS[period]}</option>)}
                </select>
                <select
                  className="settings-select"
                  aria-label={t('budget.form.scopeAria')}
                  value={draft.scopeKind}
                  onChange={(event) => setDraft({ ...draft, scopeKind: event.target.value as BudgetScopeKind, scopeId: '' })}
                >
                  {BUDGET_SCOPE_KINDS.map((kind) => <option key={kind} value={kind}>{BUDGET_SCOPE_LABELS[kind]}</option>)}
                </select>
                {draft.scopeKind !== 'all' && (
                  <>
                    <input
                      className="settings-input"
                      aria-label={t('budget.form.scopeIdAria', { scope: BUDGET_SCOPE_LABELS[draft.scopeKind] })}
                      placeholder={draft.scopeKind === 'tool' ? t('budget.form.toolPlaceholder') : draft.scopeKind === 'model' ? t('budget.form.modelPlaceholder') : t('budget.form.providerPlaceholder')}
                      value={draft.scopeId}
                      maxLength={128}
                      list={listId}
                      onChange={(event) => setDraft({ ...draft, scopeId: event.target.value })}
                    />
                    <datalist id={listId}>
                      {suggestions.map((value) => (
                        <option key={value} value={value}>
                          {draft.scopeKind === 'tool' ? toolDisplayName(value) : value}
                        </option>
                      ))}
                    </datalist>
                  </>
                )}
              </div>
            </SettingsRow>
            {draft.scopeKind === 'provider' && report && !choices.providersAvailable && (
              <p className="settings-hint" role="note">{t('budget.form.noGateway')}</p>
            )}
            <SettingsRow label={t('budget.form.limitLabel')} hint={t('budget.form.limitHint')} wideControl>
              <div className="budget-form-fields">
                <select
                  className="settings-select"
                  aria-label={t('budget.form.metricAria')}
                  value={draft.metric}
                  onChange={(event) => setDraft({ ...draft, metric: event.target.value as BudgetMetric })}
                >
                  {BUDGET_METRICS.map((metric) => <option key={metric} value={metric}>{BUDGET_METRIC_LABELS[metric]}</option>)}
                </select>
                <input
                  className="settings-input"
                  aria-label={t('budget.form.limitAria')}
                  inputMode="decimal"
                  placeholder={draft.metric === 'cost' ? t('budget.form.costPlaceholder') : t('budget.form.tokensPlaceholder')}
                  value={draft.limit}
                  onChange={(event) => setDraft({ ...draft, limit: event.target.value })}
                />
                <select
                  className="settings-select"
                  aria-label={t('budget.form.warnAria')}
                  value={String(draft.warnPercent)}
                  onChange={(event) => setDraft({ ...draft, warnPercent: Number(event.target.value) })}
                >
                  {BUDGET_WARN_PERCENTS.map((value) => <option key={value} value={value}>{t('budget.form.warnOption', { percent: value })}</option>)}
                </select>
              </div>
            </SettingsRow>
            {formError && <p className="settings-error" role="alert">{formError}</p>}
            <SettingsActionRow>
              <button
                type="submit"
                className="primary-inline"
                disabled={disabled || full}
                title={full ? t('budget.form.max', { count: MAX_BUDGET_RULES }) : undefined}
              >
                {draft.id ? t('budget.form.save') : t('budget.form.add')}
              </button>
              {draft.id && (
                <button type="button" className="secondary-inline" onClick={() => { setDraft(EMPTY_DRAFT); setFormError(''); }}>
                  {t('budget.form.cancel')}
                </button>
              )}
            </SettingsActionRow>
          </SettingsGroup>
        </form>
      </SettingsCard>

      <AlertWebhookCard />
    </SettingsSection>
  );
}
