import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import {
  PROJECT_DIMENSION_CONSENT_VERSION,
  parseProjectDimensionStatus,
  projectCommandError,
  type ProjectDimensionStatus,
} from '../utils/projectDimension';

/**
 * 本机项目索引的开关与进度。不走 `save_settings`：开启、关闭与清除在数据库事务里完成
 * （T10.165 / ADR-016）。
 */
export function useProjectDimension(active = true) {
  const [status, setStatus] = useState<ProjectDimensionStatus | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const apply = useCallback((raw: unknown) => {
    const next = parseProjectDimensionStatus(raw);
    if (!next) {
      setError('项目索引状态无法识别，开关保持关闭。');
      return null;
    }
    setStatus(next);
    setError('');
    return next;
  }, []);

  const refresh = useCallback(async () => {
    try {
      apply(await invoke('get_project_dimension_status'));
    } catch (cause) {
      setError(projectCommandError(cause));
    } finally {
      setLoaded(true);
    }
  }, [apply]);

  useEffect(() => {
    if (!active) return undefined;
    let disposed = false;
    const stops: Array<() => void> = [];
    void refresh();
    void listen<unknown>('project-index-updated', (event) => {
      if (!disposed) apply(event.payload);
    }).then((stop) => {
      if (disposed) stop();
      else stops.push(stop);
    }).catch(() => undefined);
    void listen<{ done?: number; total?: number }>('project-index-progress', (event) => {
      if (disposed) return;
      const done = event.payload?.done;
      const total = event.payload?.total;
      if (typeof done !== 'number' || typeof total !== 'number') return;
      setStatus((current) => (current ? { ...current, backfill: { ...current.backfill, done, total, status: 'running' } } : current));
    }).then((stop) => {
      if (disposed) stop();
      else stops.push(stop);
    }).catch(() => undefined);
    return () => {
      disposed = true;
      stops.forEach((stop) => stop());
    };
  }, [active, apply, refresh]);

  const setEnabled = useCallback(async (enabled: boolean) => {
    setBusy(true);
    setError('');
    try {
      const next = apply(await invoke('set_project_dimension', {
        enabled,
        consentVersion: enabled ? PROJECT_DIMENSION_CONSENT_VERSION : null,
      }));
      if (!next) return null;
      return next;
    } catch (cause) {
      setError(projectCommandError(cause));
      return null;
    } finally {
      setBusy(false);
    }
  }, [apply]);

  const rebuild = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const next = apply(await invoke('rebuild_project_index'));
      if (!next) return null;
      return next;
    } catch (cause) {
      setError(projectCommandError(cause));
      return null;
    } finally {
      setBusy(false);
    }
  }, [apply]);

  return { status, loaded, busy, error, refresh, setEnabled, rebuild };
}
