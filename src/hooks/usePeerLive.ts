import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

/** `peer_live_snapshot` 的一项：外部网关网关正在处理的请求（契约 peer-live-v1）。 */
export interface PeerLiveRequest {
  id: number;
  agent: string;
  /** 路由决定前为空。 */
  model: string;
  provider: string;
  started: string;
  ms: number;
  /** `slot` 排队、`rpm` 等配额窗口、`upstream` 已发往上游；未知时为空。 */
  phase: string;
}

/** 最近完成的一次路由的一次尝试。 */
export interface PeerRouteAttempt {
  provider: string;
  /** `rejected`：未发往供应商就被拒绝（如限额）。 */
  outcome: 'ok' | 'failed' | 'rejected';
  /** 失败时的 HTTP 状态码。 */
  status?: number;
}

/**外部网关最近完成的路由，尝试按先后排列；回退时有多次尝试。 */
export interface PeerRecentRoute {
  id: string;
  agent: string;
  model: string;
  ended: string;
  /** 最多 16 次：前面的尝试加上最后一次，最终结果总在末尾。 */
  attempts: PeerRouteAttempt[];
  /** 中间省略的尝试数，没有省略时不出现。 */
  omitted?: number;
}

export interface PeerLiveSnapshot {
  reachable: boolean;
  port: number;
  requests: number;
  waiting: number;
  tools: number;
  active: PeerLiveRequest[];
  /** 最多 32 条，最新在前；外部网关网关没运行时也会读取。 */
  recent: PeerRecentRoute[];
}

/**
 * 轮询外部网关的实时路由状态，供路由动画使用。外部网关允许每秒读取一次；
 * 页面隐藏时暂停，`enabled = false` 时不发请求。停用或换端口时清空旧快照；
 * 读取出错时保留上一次快照但 `stale = true`，调用方不要把它当作当前状态。
 */
export function usePeerLive(enabled: boolean, intervalMs = 1000, port?: number) {
  const [snapshot, setSnapshot] = useState<PeerLiveSnapshot | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    setSnapshot(null);
    setError('');
    if (!enabled) return undefined;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (typeof document === 'undefined' || document.visibilityState !== 'hidden') {
        try {
          const next = await invoke<PeerLiveSnapshot>('peer_live_snapshot', port ? { port } : {});
          if (!cancelled) {
            setSnapshot(next);
            setError('');
          }
        } catch (cause) {
          if (!cancelled) setError(typeof cause === 'string' ? cause : '读取外部网关实时状态失败。');
        }
      }
      if (!cancelled) timer = setTimeout(() => void tick(), Math.max(intervalMs, 1000));
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [enabled, intervalMs, port]);

  return { snapshot, error, stale: snapshot !== null && error !== '' };
}
