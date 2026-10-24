import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { beginRequest, isCurrentRequest } from '../utils/contracts/statsQuery';
import { localized, t } from '../i18n';

/**
 * 预算与超支提醒（`src-tauri/src/budget.rs`）。预算只看已经发生的用量，按今日 / 本周 /
 * 本月的日历周期，与看板同一份本机统计；不做外推预测。
 */
export const BUDGET_PERIODS = ['day', 'week', 'month'] as const;
export const BUDGET_METRICS = ['cost', 'tokens'] as const;
export const BUDGET_SCOPE_KINDS = ['all', 'tool', 'model', 'provider'] as const;
export const BUDGET_WARN_PERCENTS = [50, 70, 80, 90] as const;
export const MAX_BUDGET_RULES = 32;

export type BudgetPeriod = (typeof BUDGET_PERIODS)[number];
export type BudgetMetric = (typeof BUDGET_METRICS)[number];
export type BudgetScopeKind = (typeof BUDGET_SCOPE_KINDS)[number];
export type BudgetLevel = 'ok' | 'warn' | 'over' | 'unavailable';

export interface BudgetRule {
  id: string;
  enabled: boolean;
  period: BudgetPeriod;
  metric: BudgetMetric;
  scopeKind: BudgetScopeKind;
  scopeId: string;
  limit: number;
  warnPercent: number;
}

export interface BudgetSettings {
  notify: boolean;
  syncToPhone: boolean;
  rules: BudgetRule[];
}

export interface BudgetStatus {
  ruleId: string;
  periodStart: string;
  used: number | null;
  limit: number;
  percent: number | null;
  level: BudgetLevel;
}

export interface BudgetChoices {
  tools: string[];
  models: string[];
  providers: string[];
  providersAvailable: boolean;
}

export type PhoneSyncState = 'off' | 'signed-out' | 'ok' | 'not-deployed' | 'error';

export interface PhoneSyncStatus {
  state: PhoneSyncState;
  lastPublishedAt: string | null;
  error: string | null;
}

export interface BudgetStatusReport {
  generatedAt: string;
  statuses: BudgetStatus[];
  choices: BudgetChoices;
  phoneSync: PhoneSyncStatus;
}

export const DEFAULT_BUDGET_SETTINGS: BudgetSettings = { notify: false, syncToPhone: false, rules: [] };
export const OFF_PHONE_SYNC: PhoneSyncStatus = { state: 'off', lastPublishedAt: null, error: null };
export const EMPTY_BUDGET_CHOICES: BudgetChoices = { tools: [], models: [], providers: [], providersAvailable: false };

export const BUDGET_PERIOD_LABELS = localized<BudgetPeriod>({ day: 'budget.period.day', week: 'budget.period.week', month: 'budget.period.month' });
export const BUDGET_METRIC_LABELS = localized<BudgetMetric>({ cost: 'budget.metric.cost', tokens: 'budget.metric.tokens' });
export const BUDGET_SCOPE_LABELS = localized<BudgetScopeKind>({
  all: 'budget.scope.all',
  tool: 'budget.scope.tool',
  model: 'budget.scope.model',
  provider: 'budget.scope.provider',
});

const oneOf = <T extends string>(values: readonly T[], value: unknown): T | null =>
  typeof value === 'string' && (values as readonly string[]).includes(value) ? (value as T) : null;

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function parseRule(value: unknown): BudgetRule | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const period = oneOf(BUDGET_PERIODS, record.period);
  const metric = oneOf(BUDGET_METRICS, record.metric);
  const scopeKind = oneOf(BUDGET_SCOPE_KINDS, record.scopeKind);
  const limit = finiteNumber(record.limit);
  if (typeof record.id !== 'string' || !record.id || !period || !metric || !scopeKind || limit === null || limit <= 0) {
    return null;
  }
  return {
    id: record.id,
    enabled: record.enabled !== false,
    period,
    metric,
    scopeKind,
    scopeId: typeof record.scopeId === 'string' ? record.scopeId : '',
    limit,
    warnPercent: finiteNumber(record.warnPercent) ?? 80,
  };
}

export function parseBudgetSettings(value: unknown): BudgetSettings {
  if (!value || typeof value !== 'object') return DEFAULT_BUDGET_SETTINGS;
  const record = value as { notify?: unknown; syncToPhone?: unknown; rules?: unknown };
  const rules = Array.isArray(record.rules)
    ? record.rules.map(parseRule).filter((rule): rule is BudgetRule => rule !== null)
    : [];
  return { notify: record.notify === true, syncToPhone: record.syncToPhone === true, rules };
}

const stringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

export function parseBudgetStatusReport(value: unknown): BudgetStatusReport | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as { generatedAt?: unknown; statuses?: unknown; choices?: unknown; phoneSync?: unknown };
  if (!Array.isArray(record.statuses)) return null;
  const statuses = record.statuses.flatMap((item): BudgetStatus[] => {
    if (!item || typeof item !== 'object') return [];
    const status = item as Record<string, unknown>;
    const level = oneOf(['ok', 'warn', 'over', 'unavailable'] as const, status.level);
    const limit = finiteNumber(status.limit);
    if (typeof status.ruleId !== 'string' || !level || limit === null) return [];
    return [{
      ruleId: status.ruleId,
      periodStart: typeof status.periodStart === 'string' ? status.periodStart : '',
      used: finiteNumber(status.used),
      limit,
      percent: finiteNumber(status.percent),
      level,
    }];
  });
  const choices = (record.choices && typeof record.choices === 'object' ? record.choices : {}) as Record<string, unknown>;
  const phone = (record.phoneSync && typeof record.phoneSync === 'object' ? record.phoneSync : {}) as Record<string, unknown>;
  return {
    generatedAt: typeof record.generatedAt === 'string' ? record.generatedAt : '',
    statuses,
    choices: {
      tools: stringList(choices.tools),
      models: stringList(choices.models),
      providers: stringList(choices.providers),
      providersAvailable: choices.providersAvailable === true,
    },
    phoneSync: {
      state: oneOf(['off', 'signed-out', 'ok', 'not-deployed', 'error'] as const, phone.state) ?? 'off',
      lastPublishedAt: typeof phone.lastPublishedAt === 'string' ? phone.lastPublishedAt : null,
      error: typeof phone.error === 'string' ? phone.error : null,
    },
  };
}

/** 规则 id 只在本机区分规则，不进云端；字母数字即可。 */
export function newBudgetRuleId(now: number = Date.now(), random: number = Math.random()): string {
  return `b${now.toString(36)}${Math.floor(random * 1e6).toString(36)}`;
}

export function useBudgetSettings() {
  const [settings, setSettings] = useState<BudgetSettings>(DEFAULT_BUDGET_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const saveId = useRef(0);

  useEffect(() => {
    let active = true;
    invoke<unknown>('get_budget_settings')
      .then((value) => {
        if (active) setSettings(parseBudgetSettings(value));
      })
      .catch(() => {
        if (active) setError(t('budget.error.load'));
      })
      .finally(() => {
        if (active) setLoaded(true);
      });
    return () => {
      active = false;
    };
  }, []);

  const save = useCallback(async (next: BudgetSettings): Promise<boolean> => {
    const requestId = beginRequest(saveId);
    const previous = settings;
    setSettings(next);
    setSaving(true);
    setError('');
    try {
      const response = await invoke<unknown>('set_budget_settings', { settings: next });
      if (isCurrentRequest(saveId, requestId)) setSettings(parseBudgetSettings(response));
      return true;
    } catch {
      if (!isCurrentRequest(saveId, requestId)) return false;
      setSettings(previous);
      setError(t('budget.error.save'));
      return false;
    } finally {
      if (isCurrentRequest(saveId, requestId)) setSaving(false);
    }
  }, [settings]);

  return { settings, loaded, saving, error, save };
}

/** 读取当前各预算的用量；本机统计更新（`stats-updated`）或 `revision` 变化时重读。 */
export function useBudgetStatus(revision: unknown) {
  const [report, setReport] = useState<BudgetStatusReport | null>(null);
  const [error, setError] = useState('');
  const loadId = useRef(0);

  const reload = useCallback(() => {
    const requestId = beginRequest(loadId);
    invoke<unknown>('get_budget_status')
      .then((value) => {
        if (!isCurrentRequest(loadId, requestId)) return;
        const parsed = parseBudgetStatusReport(value);
        setReport(parsed);
        setError(parsed ? '' : t('budget.error.status'));
      })
      .catch(() => {
        if (isCurrentRequest(loadId, requestId)) setError(t('budget.error.status'));
      });
  }, []);

  useEffect(() => {
    reload();
  }, [reload, revision]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    listen('stats-updated', () => reload())
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [reload]);

  // 周期按本地日历走：窗口重新可见、跨日、或每 5 分钟（网关用量不发 stats-updated）重读一次，
  // 页面不会停在昨天的读数上，与托盘一致。
  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    let day = new Date().toDateString();
    let lastLoad = Date.now();
    const reconcile = (force: boolean) => {
      if (document.visibilityState !== 'visible') return;
      const today = new Date().toDateString();
      if (force || today !== day || Date.now() - lastLoad >= BUDGET_STATUS_REFRESH_MS) {
        day = today;
        lastLoad = Date.now();
        reload();
      }
    };
    const onVisibility = () => reconcile(true);
    const timer = setInterval(() => reconcile(false), 60_000);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [reload]);

  return { report, error, reload };
}

export const BUDGET_STATUS_REFRESH_MS = 5 * 60_000;
