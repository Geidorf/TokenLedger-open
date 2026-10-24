import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  beginRequest,
  invalidateRequest,
  isCurrentRequest,
  parseQuotaProviderEnvelopes,
  parseQuotaSyncStatus,
  quotaClearErrorFeedback,
  quotaClearFeedback,
  quotaSyncNowFeedback,
  shouldRefreshVisibleQuotas,
} from '../utils/frontendContracts';
import { AppSettings, QuotaProviderEnvelope, QuotaSyncStatus, ToastType } from '../types';
import { formatQuotaLoadError } from '../utils/quotaError';
import { nextQuotaResetTimerDelay, quotaResetSchedules } from '../utils/quotaReset';
import type { RequestConfirmation } from '../utils/confirmation';

const QUOTA_AUTO_REFRESH_INTERVAL_MS = 5 * 60_000;
const MAX_RECORDED_QUOTA_RESETS = 256;

export interface UseQuotaProps {
  showMessage: (type: ToastType, text: string) => void;
  confirm: RequestConfirmation;
  loadSettings: (silent?: boolean) => Promise<boolean | void>;
  saveAppSettings: (next: AppSettings) => Promise<boolean>;
  appSettings: AppSettings;
  setAppSettings: (settings: AppSettings | ((prev: AppSettings) => AppSettings)) => void;
  clearPendingSettings: () => void;
  setBusy: (fn: (p: any) => any) => void;
}

export function useQuota({
  showMessage,
  confirm,
  loadSettings,
  saveAppSettings,
  appSettings,
  setAppSettings,
  clearPendingSettings,
  setBusy,
}: UseQuotaProps) {
  const [quotaProviders, setQuotaProviders] = useState<QuotaProviderEnvelope[]>([]);
  const [quotaLoading, setQuotaLoading] = useState(false);
  const [quotaError, setQuotaError] = useState('');
  const quotaRequestId = useRef(0);
  const lastSuccessfulIncludeRemote = useRef(false);
  const quotaLastRequestedAt = useRef(0);
  const quotaLoadCount = useRef(0);
  const quotaResetTimer = useRef<number | null>(null);
  const scheduleQuotaResetRefresh = useRef<(() => void) | null>(null);
  const knownFutureQuotaResets = useRef(new Set<string>());
  const attemptedQuotaResets = useRef(new Map<string, number>());
  const quotaSyncRequestId = useRef(0);
  const quotaBindingId = useRef(0);
  // Busy ownership is independent of status reads and binding invalidation.
  const quotaMutationId = useRef(0);
  const [quotaSyncStatus, setQuotaSyncStatus] = useState<QuotaSyncStatus>({ enabled: false, state: 'disabled' });

  const loadQuotas = useCallback(async (includeRemote?: boolean, retrySecureStorage = false): Promise<boolean | undefined> => {
    const resolvedIncludeRemote = includeRemote ?? lastSuccessfulIncludeRemote.current;
    const bindingId = quotaBindingId.current;
    quotaLastRequestedAt.current = Date.now();
    quotaLoadCount.current += 1;
    const requestId = beginRequest(quotaRequestId);
    setQuotaLoading(true);
    setQuotaError('');
    try {
      const command = retrySecureStorage
        ? resolvedIncludeRemote ? 'retry_quota_providers' : 'retry_local_quota_providers'
        : resolvedIncludeRemote ? 'get_quota_providers' : 'get_local_quota_providers';
      const response = await invoke<unknown>(command);
      if (!isCurrentRequest(quotaRequestId, requestId)) return undefined;
      const providers = parseQuotaProviderEnvelopes(response);
      lastSuccessfulIncludeRemote.current = resolvedIncludeRemote;
      setQuotaProviders(providers);
      return true;
    } catch (err) {
      if (!isCurrentRequest(quotaRequestId, requestId)) return undefined;
      setQuotaError(formatQuotaLoadError(err));
      return false;
    } finally {
      if (isCurrentRequest(quotaRequestId, requestId)) setQuotaLoading(false);
      if (!isCurrentRequest(quotaBindingId, bindingId)) return undefined;
      quotaLoadCount.current = Math.max(0, quotaLoadCount.current - 1);
      scheduleQuotaResetRefresh.current?.();
    }
  }, []);

  const invalidateQuotaRequests = useCallback(() => {
    invalidateRequest(quotaBindingId);
    invalidateRequest(quotaRequestId);
    invalidateRequest(quotaSyncRequestId);
    // Native reads cannot always be cancelled. Once the binding changes, their
    // outstanding count must not suppress foreground/reset refreshes for the
    // new account; stale finally blocks are ignored by request generations.
    quotaLoadCount.current = 0;
    setQuotaLoading(false);
  }, []);

  const resetQuotaBinding = useCallback(() => {
    invalidateQuotaRequests();
    lastSuccessfulIncludeRemote.current = false;
    quotaLastRequestedAt.current = 0;
    knownFutureQuotaResets.current.clear();
    attemptedQuotaResets.current.clear();
    if (quotaResetTimer.current !== null) {
      window.clearTimeout(quotaResetTimer.current);
      quotaResetTimer.current = null;
    }
    setQuotaProviders([]);
    setQuotaError('');
    setQuotaSyncStatus({ enabled: false, state: 'disabled' });
  }, [invalidateQuotaRequests]);

  const refreshQuotasAutomatically = useCallback(() => {
    // A foreground timer never competes with a user retry or another automatic
    // signal. Explicit retry remains a separate call and is therefore never
    // silently discarded behind this guard.
    if (quotaLoadCount.current > 0) return false;
    void loadQuotas();
    return true;
  }, [loadQuotas]);

  const loadQuotaSyncStatus = useCallback(async () => {
    const requestId = beginRequest(quotaSyncRequestId);
    try {
      const response = await invoke<unknown>('get_quota_snapshot_sync_status');
      if (!isCurrentRequest(quotaSyncRequestId, requestId)) return;
      setQuotaSyncStatus(parseQuotaSyncStatus(response));
    } catch (err) {
      if (!isCurrentRequest(quotaSyncRequestId, requestId)) return;
      setQuotaSyncStatus({ enabled: false, state: 'unavailable', reasonCode: 'quota_sync_status_unavailable' });
    }
  }, []);

  const authorizeClaudeNativeQuota = useCallback(async () => {
    setBusy((p: any) => ({ ...p, settings: true }));
    try {
      const message = await invoke<string>('authorize_claude_native_quota');
      showMessage('success', message);
      await Promise.all([loadQuotas(), loadQuotaSyncStatus()]);
    } catch (err) {
      showMessage('error', `Claude 额度读取失败: ${err}`);
      await loadQuotas();
    } finally {
      setBusy((p: any) => ({ ...p, settings: false }));
    }
  }, [loadQuotaSyncStatus, loadQuotas, setBusy, showMessage]);

  const changeClaudeNativeQuota = useCallback(async (enabled: boolean) => {
    clearPendingSettings();
    const next = { ...appSettings, quota_claude_codexbar_enabled: enabled };
    setAppSettings(next);
    const saved = await saveAppSettings(next);
    if (saved && enabled) await authorizeClaudeNativeQuota();
  }, [appSettings, authorizeClaudeNativeQuota, clearPendingSettings, saveAppSettings, setAppSettings]);

  const authorizeAntigravityQuota = useCallback(async () => {
    setBusy((p: any) => ({ ...p, settings: true }));
    try {
      const message = await invoke<string>('authorize_antigravity_quota');
      showMessage('success', message);
      await Promise.all([loadQuotas(), loadQuotaSyncStatus()]);
    } catch (err) {
      showMessage('error', `Antigravity 额度读取失败: ${err}`);
      await loadQuotas();
    } finally {
      setBusy((p: any) => ({ ...p, settings: false }));
    }
  }, [loadQuotaSyncStatus, loadQuotas, setBusy, showMessage]);

  const changeAntigravityLocalQuota = useCallback(async (enabled: boolean) => {
    clearPendingSettings();
    const next = { ...appSettings, quota_antigravity_local_enabled: enabled };
    if (!enabled && appSettings.quota_antigravity_codexbar_enabled) {
      next.quota_antigravity_codexbar_enabled = false;
    }
    setAppSettings(next);
    const saved = await saveAppSettings(next);
    if (saved && enabled) await authorizeAntigravityQuota();
  }, [appSettings, authorizeAntigravityQuota, clearPendingSettings, saveAppSettings, setAppSettings]);

  const toggleQuotaSnapshotSync = useCallback(async (enabled: boolean) => {
    const bindingId = quotaBindingId.current;
    invalidateRequest(quotaSyncRequestId);
    const mutationId = beginRequest(quotaMutationId);
    const isCurrentMutation = () => isCurrentRequest(quotaBindingId, bindingId)
      && isCurrentRequest(quotaMutationId, mutationId);
    setBusy((previous: any) => ({ ...previous, settings: true }));
    try {
      const response = await invoke<unknown>('set_quota_snapshot_sync_enabled', { enabled });
      if (!isCurrentMutation()) return;
      invalidateRequest(quotaSyncRequestId);
      const status = parseQuotaSyncStatus(response);
      setQuotaSyncStatus(status);
      await loadSettings();
      if (!isCurrentMutation()) return;
      showMessage(
        status.reasonCode ? 'info' : 'success',
        enabled
          ? '跨设备额度同步已显式启用'
          : '跨设备额度同步已关闭；本机停止读写，云端历史仍保留',
      );
    } catch (err) {
      if (!isCurrentMutation()) return;
      showMessage('error', `额度同步设置失败: ${String(err)}`);
      await Promise.all([loadSettings(), loadQuotaSyncStatus()]);
    } finally {
      if (isCurrentRequest(quotaMutationId, mutationId)) {
        setBusy((previous: any) => ({ ...previous, settings: false }));
      }
    }
  }, [loadQuotaSyncStatus, loadSettings, setBusy, showMessage]);

  const syncQuotaSnapshotsNow = useCallback(async () => {
    const bindingId = quotaBindingId.current;
    invalidateRequest(quotaSyncRequestId);
    setQuotaSyncStatus((previous) => ({ ...previous, state: 'syncing' }));
    const mutationId = beginRequest(quotaMutationId);
    const isCurrentMutation = () => isCurrentRequest(quotaBindingId, bindingId)
      && isCurrentRequest(quotaMutationId, mutationId);
    setBusy((previous: any) => ({ ...previous, settings: true }));
    try {
      const response = await invoke<unknown>('sync_quota_snapshots_now');
      if (!isCurrentMutation()) return;
      invalidateRequest(quotaSyncRequestId);
      const status = parseQuotaSyncStatus(response);
      setQuotaSyncStatus(status);
      await loadSettings();
      if (!isCurrentMutation()) return;
      const feedback = quotaSyncNowFeedback(status);
      showMessage(feedback.type, feedback.message);
    } catch (err) {
      if (!isCurrentMutation()) return;
      showMessage('error', `额度同步失败: ${String(err)}`);
      await loadQuotaSyncStatus();
    } finally {
      if (isCurrentRequest(quotaMutationId, mutationId)) {
        setBusy((previous: any) => ({ ...previous, settings: false }));
      }
    }
  }, [loadQuotaSyncStatus, loadSettings, setBusy, showMessage]);

  const deleteQuotaSnapshotProvider = useCallback(async (providerId: string, scope: string) => {
    const confirmationId = quotaBindingId.current;
    if (!(await confirm({
      title: '删除这个来源的云端额度快照？',
      description: '仅删除这个来源的云端快照；之后新的本机观测仍可同步。',
      confirmLabel: '删除快照',
      tone: 'danger',
    }))) return false;
    if (!isCurrentRequest(quotaBindingId, confirmationId)) return false;
    const bindingId = quotaBindingId.current;
    invalidateRequest(quotaSyncRequestId);
    const mutationId = beginRequest(quotaMutationId);
    const isCurrentMutation = () => isCurrentRequest(quotaBindingId, bindingId)
      && isCurrentRequest(quotaMutationId, mutationId);
    setBusy((previous: any) => ({ ...previous, settings: true }));
    try {
      const response = await invoke<unknown>('delete_quota_snapshot_provider', { providerId, scope });
      if (!isCurrentMutation()) return false;
      invalidateRequest(quotaSyncRequestId);
      setQuotaSyncStatus(parseQuotaSyncStatus(response));
      showMessage('success', '已删除这个来源的云端额度快照；新的本机观测仍可同步');
      await loadQuotas();
      return true;
    } catch (err) {
      if (!isCurrentMutation()) return false;
      showMessage('error', `删除这个来源的云端额度快照失败: ${String(err)}`);
      await loadQuotaSyncStatus();
      return false;
    } finally {
      if (isCurrentRequest(quotaMutationId, mutationId)) {
        setBusy((previous: any) => ({ ...previous, settings: false }));
      }
    }
  }, [confirm, loadQuotas, loadQuotaSyncStatus, setBusy, showMessage]);

  const clearQuotaSnapshots = useCallback(async () => {
    const confirmationId = quotaBindingId.current;
    if (!(await confirm({
      title: '删除全部云端额度快照？',
      description: '会删除当前账户下全部云端额度历史，包括其他设备留下的快照；无法撤销，不会删除本机用量账本。发送删除前先关闭本机额度同步；删除失败仍保持关闭，不会自动恢复，之后需手动重新启用。取消确认不会发送删除或关闭同步；发送后若超时或取消，云端结果可能未知，请先检查状态，不要当作已撤销。',
      confirmLabel: '删除全部快照',
      tone: 'danger',
    }))) return false;
    if (!isCurrentRequest(quotaBindingId, confirmationId)) return false;
    const bindingId = quotaBindingId.current;
    invalidateRequest(quotaSyncRequestId);
    const mutationId = beginRequest(quotaMutationId);
    const isCurrentMutation = () => isCurrentRequest(quotaBindingId, bindingId)
      && isCurrentRequest(quotaMutationId, mutationId);
    setBusy((previous: any) => ({ ...previous, settings: true }));
    try {
      const response = await invoke<unknown>('clear_quota_snapshots');
      if (!isCurrentMutation()) return false;
      invalidateRequest(quotaSyncRequestId);
      const status = parseQuotaSyncStatus(response);
      setQuotaSyncStatus(status);
      const feedback = quotaClearFeedback(status);
      if (feedback.type !== 'success') {
        showMessage(feedback.type, feedback.message);
        await Promise.allSettled([loadSettings(), loadQuotaSyncStatus()]);
        return false;
      }
      const reloadResults = await Promise.allSettled([loadSettings(true), loadQuotas()]);
      if (!isCurrentMutation()) return false;
      if (reloadResults.some((result) => result.status === 'rejected'
        || (result.status === 'fulfilled' && result.value === false))) {
        showMessage('error', '云端已确认删除且本机同步已关闭，但界面状态刷新失败。请重新打开额度设置查看状态，不要重复删除');
        return false;
      }
      const quotaReload = reloadResults[1];
      if (quotaReload.status === 'fulfilled' && quotaReload.value === undefined) {
        showMessage('warning', '云端已确认删除且本机同步已关闭，但额度界面刷新结果尚未确认。请重新打开额度设置查看状态，不要重复删除');
        return false;
      }
      showMessage(feedback.type, feedback.message);
      return true;
    } catch (err) {
      if (!isCurrentMutation()) return false;
      const feedback = quotaClearErrorFeedback(err);
      showMessage(feedback.type, feedback.message);
      await Promise.allSettled([loadSettings(), loadQuotaSyncStatus()]);
      return false;
    } finally {
      if (isCurrentRequest(quotaMutationId, mutationId)) {
        setBusy((previous: any) => ({ ...previous, settings: false }));
      }
    }
  }, [confirm, loadQuotas, loadQuotaSyncStatus, loadSettings, setBusy, showMessage]);

  useEffect(() => {
    const clearResetTimer = () => {
      if (quotaResetTimer.current !== null) {
        window.clearTimeout(quotaResetTimer.current);
        quotaResetTimer.current = null;
      }
    };
    const recordAttempt = (key: string, now: number) => {
      attemptedQuotaResets.current.set(key, now);
      while (attemptedQuotaResets.current.size > MAX_RECORDED_QUOTA_RESETS) {
        const oldest = attemptedQuotaResets.current.keys().next().value;
        if (oldest === undefined) break;
        attemptedQuotaResets.current.delete(oldest);
      }
    };
    const recordFutureReset = (key: string) => {
      knownFutureQuotaResets.current.add(key);
      while (knownFutureQuotaResets.current.size > MAX_RECORDED_QUOTA_RESETS) {
        const oldest = knownFutureQuotaResets.current.values().next().value;
        if (oldest === undefined) break;
        knownFutureQuotaResets.current.delete(oldest);
      }
    };
    const scheduleResetRefresh = () => {
      clearResetTimer();
      const now = Date.now();
      const schedules = quotaResetSchedules(quotaProviders);
      const currentScheduleKeys = new Set(schedules.map((schedule) => schedule.key));
      for (const key of knownFutureQuotaResets.current) {
        if (!currentScheduleKeys.has(key)) knownFutureQuotaResets.current.delete(key);
      }
      for (const schedule of schedules) {
        // Only a reset observed before its boundary earns an automatic
        // follow-up. A cold-start LKG that was already expired must not start
        // a refresh loop merely because it still carries a reset timestamp.
        if (schedule.resetAt > now) recordFutureReset(schedule.key);
      }
      // A provider can finish while the window is hidden. Preserve the future
      // boundary now, then defer the timer/read/attempt until it is visible.
      if (document.visibilityState !== 'visible') return;
      const due = schedules.filter((schedule) => (
        knownFutureQuotaResets.current.has(schedule.key)
        && schedule.refreshAt <= now
        && !attemptedQuotaResets.current.has(schedule.key)
      ));
      if (due.length > 0 && refreshQuotasAutomatically()) {
        due.forEach((schedule) => {
          recordAttempt(schedule.key, now);
          knownFutureQuotaResets.current.delete(schedule.key);
        });
      }
      const next = schedules.find((schedule) => (
        knownFutureQuotaResets.current.has(schedule.key)
        && !attemptedQuotaResets.current.has(schedule.key)
        && schedule.refreshAt > now
      ));
      if (next) {
        quotaResetTimer.current = window.setTimeout(scheduleResetRefresh, nextQuotaResetTimerDelay(next.refreshAt, now));
      }
    };
    scheduleQuotaResetRefresh.current = scheduleResetRefresh;
    scheduleResetRefresh();
    return () => {
      if (scheduleQuotaResetRefresh.current === scheduleResetRefresh) {
        scheduleQuotaResetRefresh.current = null;
      }
      clearResetTimer();
    };
  }, [quotaProviders, refreshQuotasAutomatically]);

  useEffect(() => {
    const refreshVisibleQuotas = () => {
      const now = Date.now();
      if (document.visibilityState === 'visible') {
        // A browser may suspend timers while the tray-resident window is
        // hidden, so visibility/focus must re-evaluate the same reset plan.
        scheduleQuotaResetRefresh.current?.();
      }
      if (!shouldRefreshVisibleQuotas(
        document.visibilityState,
        quotaLastRequestedAt.current,
        now,
        QUOTA_AUTO_REFRESH_INTERVAL_MS,
      )) return;
      refreshQuotasAutomatically();
    };
    const timer = window.setInterval(refreshVisibleQuotas, QUOTA_AUTO_REFRESH_INTERVAL_MS);
    window.addEventListener('focus', refreshVisibleQuotas);
    document.addEventListener('visibilitychange', refreshVisibleQuotas);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', refreshVisibleQuotas);
      document.removeEventListener('visibilitychange', refreshVisibleQuotas);
    };
  }, [refreshQuotasAutomatically]);

  return {
    quotaProviders,
    setQuotaProviders,
    quotaLoading,
    quotaError,
    quotaSyncStatus,
    setQuotaSyncStatus,
    quotaRequestId,
    quotaSyncRequestId,
    invalidateQuotaRequests,
    resetQuotaBinding,
    loadQuotas,
    loadQuotaSyncStatus,
    authorizeClaudeNativeQuota,
    changeClaudeNativeQuota,
    authorizeAntigravityQuota,
    changeAntigravityLocalQuota,
    toggleQuotaSnapshotSync,
    syncQuotaSnapshotsNow,
    deleteQuotaSnapshotProvider,
    clearQuotaSnapshots,
  };
}

/** 本机额度告警（REQ-QUOTA-07）：剩余比例档位，闭合集合，与 Rust `quota::alerts` 一致。 */
export const QUOTA_ALERT_THRESHOLDS = [50, 20, 5] as const;
export type QuotaAlertThreshold = (typeof QUOTA_ALERT_THRESHOLDS)[number];

export interface QuotaAlertSettings {
  enabled: boolean;
  thresholds: QuotaAlertThreshold[];
}

export const DEFAULT_QUOTA_ALERT_SETTINGS: QuotaAlertSettings = { enabled: false, thresholds: [20] };

export function parseQuotaAlertSettings(value: unknown): QuotaAlertSettings {
  if (!value || typeof value !== 'object') return DEFAULT_QUOTA_ALERT_SETTINGS;
  const record = value as { enabled?: unknown; thresholds?: unknown };
  const thresholds = Array.isArray(record.thresholds)
    ? QUOTA_ALERT_THRESHOLDS.filter((threshold) => (record.thresholds as unknown[]).includes(threshold))
    : [];
  return {
    enabled: record.enabled === true,
    thresholds: thresholds.length > 0 ? thresholds : [...DEFAULT_QUOTA_ALERT_SETTINGS.thresholds],
  };
}

/** 切换一个档位；至少保留一档。 */
export function toggleQuotaAlertThreshold(
  thresholds: readonly QuotaAlertThreshold[],
  threshold: QuotaAlertThreshold,
): QuotaAlertThreshold[] {
  const next = thresholds.includes(threshold)
    ? thresholds.filter((value) => value !== threshold)
    : [...thresholds, threshold];
  if (next.length === 0) return [...thresholds];
  return QUOTA_ALERT_THRESHOLDS.filter((value) => next.includes(value));
}

export function useQuotaAlertSettings() {
  const [settings, setSettings] = useState<QuotaAlertSettings>(DEFAULT_QUOTA_ALERT_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const saveId = useRef(0);

  useEffect(() => {
    let active = true;
    invoke<unknown>('get_quota_alert_settings')
      .then((value) => {
        if (active) setSettings(parseQuotaAlertSettings(value));
      })
      .catch(() => {
        if (active) setError('读取提醒设置失败');
      })
      .finally(() => {
        if (active) setLoaded(true);
      });
    return () => {
      active = false;
    };
  }, []);

  // 本机备份恢复了额度提醒（或别处改了设置）后重读，免得下一次修改把旧整份写回去。
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    const install = async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');
        const cleanup = await listen('settings-updated', () => {
          invoke<unknown>('get_quota_alert_settings')
            .then((value) => {
              if (!cancelled) setSettings(parseQuotaAlertSettings(value));
            })
            .catch(() => {});
        });
        if (cancelled) cleanup();
        else unlisten = cleanup;
      } catch {
        // 浏览器 fixture 没有原生事件桥。
      }
    };
    void install();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const save = useCallback(async (next: QuotaAlertSettings) => {
    const requestId = beginRequest(saveId);
    const previous = settings;
    setSettings(next);
    setSaving(true);
    setError('');
    try {
      const response = await invoke<unknown>('set_quota_alert_settings', { settings: next });
      if (isCurrentRequest(saveId, requestId)) setSettings(parseQuotaAlertSettings(response));
    } catch {
      if (!isCurrentRequest(saveId, requestId)) return;
      setSettings(previous);
      setError('提醒设置未保存，请重试');
    } finally {
      if (isCurrentRequest(saveId, requestId)) setSaving(false);
    }
  }, [settings]);

  return { settings, loaded, saving, error, save };
}
