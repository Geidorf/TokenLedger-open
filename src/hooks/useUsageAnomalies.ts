import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { beginRequest, isCurrentRequest } from '../utils/contracts/statsQuery';
import {
  parseAnomalyReport,
  parseAnomalySettings,
  type AnomalyReport,
  type AnomalySettings,
} from '../utils/usageAnomaly';

/** 网关用量不发 `stats-updated`，窗口可见时每 5 分钟也重读一次，与后台提醒同一节奏。 */
const ANOMALY_REFRESH_MS = 5 * 60_000;

/** 本机用量异常（`get_usage_anomalies`）。`enabled` 为 false（云端范围）时不读。 */
export function useUsageAnomalies(enabled: boolean) {
  const [report, setReport] = useState<AnomalyReport | null>(null);
  const [error, setError] = useState('');
  const loadId = useRef(0);

  const reload = useCallback(() => {
    if (!enabled) return;
    const requestId = beginRequest(loadId);
    invoke<unknown>('get_usage_anomalies')
      .then((value) => {
        if (!isCurrentRequest(loadId, requestId)) return;
        const parsed = parseAnomalyReport(value);
        setReport(parsed);
        setError(parsed ? '' : '异常检测读取失败');
      })
      .catch(() => {
        if (isCurrentRequest(loadId, requestId)) setError('异常检测读取失败');
      });
  }, [enabled]);

  useEffect(() => {
    reload();
  }, [reload]);

  useEffect(() => {
    if (!enabled) return undefined;
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
  }, [enabled, reload]);

  useEffect(() => {
    if (!enabled || typeof document === 'undefined') return undefined;
    let lastLoad = Date.now();
    const reconcile = (force: boolean) => {
      if (document.visibilityState !== 'visible') return;
      if (force || Date.now() - lastLoad >= ANOMALY_REFRESH_MS) {
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
  }, [enabled, reload]);

  return { report, error, reload };
}

/** 异常提醒开关，默认关；开启后走与额度、预算提醒相同的系统通知。 */
export function useUsageAnomalySettings(enabled: boolean) {
  const [settings, setSettings] = useState<AnomalySettings>({ notify: false });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const saveId = useRef(0);

  useEffect(() => {
    if (!enabled) return undefined;
    let active = true;
    invoke<unknown>('get_usage_anomaly_settings')
      .then((value) => {
        if (active) setSettings(parseAnomalySettings(value));
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [enabled]);

  const save = useCallback(async (next: AnomalySettings) => {
    const requestId = beginRequest(saveId);
    const previous = settings;
    setSettings(next);
    setSaving(true);
    setError('');
    try {
      const response = await invoke<unknown>('set_usage_anomaly_settings', { settings: next });
      if (isCurrentRequest(saveId, requestId)) setSettings(parseAnomalySettings(response));
    } catch {
      if (!isCurrentRequest(saveId, requestId)) return;
      setSettings(previous);
      setError('提醒设置未保存，请重试');
    } finally {
      if (isCurrentRequest(saveId, requestId)) setSaving(false);
    }
  }, [settings]);

  return { settings, saving, error, save };
}
