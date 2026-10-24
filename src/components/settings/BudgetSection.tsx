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
import '../../styles/budget.css';

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
  const base = '手机端读到接近或超出时推本地通知。只上传范围名、周期和已用百分比，不上传金额与上限。';
  if (!enabled) return base;
  switch (status.state) {
    case 'ok':
      return status.lastPublishedAt
        ? `已同步，最近一次 ${new Date(status.lastPublishedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}。`
        : '已同步。';
    case 'signed-out':
      return '需要先在「云同步」登录，手机用同一账号登录后才能收到。';
    case 'not-deployed':
      return '云端尚未部署预算同步，部署后自动开始。';
    case 'error':
      return `同步失败：${status.error ?? '未知原因'}，稍后自动重试。`;
    default:
      return '正在准备同步…';
  }
}

export function budgetRuleTitle(rule: BudgetRule): string {
  return `${BUDGET_PERIOD_LABELS[rule.period]} · ${budgetScopeName(rule)} · ${BUDGET_METRIC_LABELS[rule.metric]}`;
}

function formatAmount(metric: BudgetMetric, value: number | null): string {
  return metric === 'cost' ? formatEstimatedUsd(value) : formatTokens(value);
}

/** 读数文案：已用 / 上限 · 百分比；读不到时说明原因，不当成 0。 */
export function budgetReading(rule: BudgetRule, status: BudgetStatus | undefined): string {
  if (!rule.enabled) return `已停用 · 上限 ${formatAmount(rule.metric, rule.limit)}`;
  if (!status) return `上限 ${formatAmount(rule.metric, rule.limit)} · 读取中`;
  if (status.level === 'unavailable' || status.used === null) {
    const reason = rule.scopeKind === 'provider'
      ? '账号维度需要网关记录'
      : rule.metric === 'cost' ? '有未核价的记录' : '统计暂不可读';
    return `上限 ${formatAmount(rule.metric, rule.limit)} · 用量不可得（${reason}）`;
  }
  const percent = Math.floor(status.percent ?? 0);
  const shown = percent > 999 ? '>999%' : `${percent}%`;
  return `已用 ${formatAmount(rule.metric, status.used)} / ${formatAmount(rule.metric, rule.limit)} · ${shown}`;
}

const LEVEL_LABELS: Record<BudgetStatus['level'], string> = {
  ok: '正常',
  warn: '接近上限',
  over: '已超出',
  unavailable: '不可得',
};

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
      setFormError(draft.metric === 'tokens' ? '上限至少 1 个 Token' : '上限要大于 0');
      return;
    }
    const scopeId = draft.scopeKind === 'all' ? '' : draft.scopeId.trim();
    if (draft.scopeKind !== 'all' && !scopeId) {
      setFormError(`请填写${BUDGET_SCOPE_LABELS[draft.scopeKind]}`);
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
    <SettingsSection id="budget" title="预算提醒">
      <SettingsCard title="提醒方式">
        <SettingsGroup>
          <SettingsToggleRow
            label="接近或超出预算时提醒"
            hint="系统通知，每条预算每个周期接近与超出各一次；托盘提示同时显示。"
            icon={Bell}
            checked={settings.notify}
            disabled={disabled}
            busy={saving}
            onChange={(notify) => void save({ ...settings, notify })}
          />
          <SettingsToggleRow
            label="同步到手机"
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
        title="预算"
        description="只看已经发生的用量，按日历周期统计（每周从周一算起），与看板同一份本机数据。"
      >
        <SettingsGroup>
          {settings.rules.length === 0 && (
            <SettingsRow label="还没有预算" hint="在下面新增一条，例如「本月 · 全部用量 · 预估费用 $50」。" icon={Wallet}>
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
                      {rule.enabled ? '停用' : '启用'}
                    </button>
                    <button type="button" className="secondary-inline" disabled={disabled} onClick={() => edit(rule)} aria-label={`编辑 ${title}`} title="编辑">
                      <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className="secondary-inline"
                      disabled={disabled}
                      aria-label={`删除 ${title}`}
                      title="删除"
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
                  aria-label={`${title}已用比例`}
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

      <SettingsCard title={draft.id ? '编辑预算' : '新增预算'}>
        <form onSubmit={(event) => void submit(event)}>
          <SettingsGroup>
            <SettingsRow label="周期与范围" hint="账号指网关记录的转发目标；只有经网关的请求能按账号统计。" icon={Plus} wideControl>
              <div className="budget-form-fields">
                <select
                  className="settings-select"
                  aria-label="预算周期"
                  value={draft.period}
                  onChange={(event) => setDraft({ ...draft, period: event.target.value as BudgetPeriod })}
                >
                  {BUDGET_PERIODS.map((period) => <option key={period} value={period}>{BUDGET_PERIOD_LABELS[period]}</option>)}
                </select>
                <select
                  className="settings-select"
                  aria-label="预算范围"
                  value={draft.scopeKind}
                  onChange={(event) => setDraft({ ...draft, scopeKind: event.target.value as BudgetScopeKind, scopeId: '' })}
                >
                  {BUDGET_SCOPE_KINDS.map((kind) => <option key={kind} value={kind}>{BUDGET_SCOPE_LABELS[kind]}</option>)}
                </select>
                {draft.scopeKind !== 'all' && (
                  <>
                    <input
                      className="settings-input"
                      aria-label={`预算${BUDGET_SCOPE_LABELS[draft.scopeKind]}`}
                      placeholder={draft.scopeKind === 'tool' ? '例如 codex' : draft.scopeKind === 'model' ? '例如 gpt-5' : '网关供应商名'}
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
              <p className="settings-hint" role="note">本机还没有网关记录，账号预算会显示为不可得，直到有请求经过网关。</p>
            )}
            <SettingsRow label="上限" hint="接近比例到达时先提醒一次，超出上限再提醒一次。" wideControl>
              <div className="budget-form-fields">
                <select
                  className="settings-select"
                  aria-label="预算口径"
                  value={draft.metric}
                  onChange={(event) => setDraft({ ...draft, metric: event.target.value as BudgetMetric })}
                >
                  {BUDGET_METRICS.map((metric) => <option key={metric} value={metric}>{BUDGET_METRIC_LABELS[metric]}</option>)}
                </select>
                <input
                  className="settings-input"
                  aria-label="预算上限"
                  inputMode="decimal"
                  placeholder={draft.metric === 'cost' ? '美元，例如 50' : 'Token 数，例如 20000000'}
                  value={draft.limit}
                  onChange={(event) => setDraft({ ...draft, limit: event.target.value })}
                />
                <select
                  className="settings-select"
                  aria-label="接近提醒比例"
                  value={String(draft.warnPercent)}
                  onChange={(event) => setDraft({ ...draft, warnPercent: Number(event.target.value) })}
                >
                  {BUDGET_WARN_PERCENTS.map((value) => <option key={value} value={value}>{`用到 ${value}% 时提醒`}</option>)}
                </select>
              </div>
            </SettingsRow>
            {formError && <p className="settings-error" role="alert">{formError}</p>}
            <SettingsActionRow>
              <button
                type="submit"
                className="primary-inline"
                disabled={disabled || full}
                title={full ? `最多 ${MAX_BUDGET_RULES} 条预算` : undefined}
              >
                {draft.id ? '保存预算' : '添加预算'}
              </button>
              {draft.id && (
                <button type="button" className="secondary-inline" onClick={() => { setDraft(EMPTY_DRAFT); setFormError(''); }}>
                  取消编辑
                </button>
              )}
            </SettingsActionRow>
          </SettingsGroup>
        </form>
      </SettingsCard>
    </SettingsSection>
  );
}
