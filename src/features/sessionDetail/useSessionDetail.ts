import { useEffect, useMemo, useState } from 'react';
import type { SessionDetailRef } from './sessionDetailRoute';
import {
  buildTimeline,
  loadPeerAverage,
  loadSessionRequests,
  summarizeSession,
  type PeerAverage,
  type SessionRequestsResult,
} from './sessionDetailData';

export type SessionDetailState =
  | { status: 'loading' }
  | { status: 'failed' }
  | { status: 'unavailable' }
  | { status: 'empty' }
  | { status: 'ready'; result: SessionRequestsResult };

/** 读取会话明细，再按会话的工具与最后日期读取同类会话平均。`revision` 变化时重读。 */
export function useSessionDetail(ref: SessionDetailRef, timezone: string, revision: number) {
  const [state, setState] = useState<SessionDetailState>({ status: 'loading' });
  const [peer, setPeer] = useState<PeerAverage | null | 'loading' | 'failed'>('loading');
  const { sessionId, tool } = ref;

  useEffect(() => {
    let current = true;
    setState({ status: 'loading' });
    setPeer('loading');
    loadSessionRequests({ sessionId, tool }, timezone)
      .then(result => {
        if (!current) return;
        if (!result) setState({ status: 'unavailable' });
        else if (!result.items.length) setState({ status: 'empty' });
        else setState({ status: 'ready', result });
      })
      .catch(() => { if (current) setState({ status: 'failed' }); });
    return () => { current = false; };
  }, [sessionId, tool, timezone, revision]);

  const timeline = useMemo(() => (state.status === 'ready' ? buildTimeline(state.result.items) : []), [state]);
  const summary = useMemo(() => (timeline.length ? summarizeSession(timeline) : null), [timeline]);

  const peerTool = summary && summary.tools.length === 1 ? summary.tool : null;
  const peerLastAt = summary?.lastAt ?? null;
  useEffect(() => {
    if (state.status !== 'ready') return;
    if (!peerTool || !peerLastAt) {
      setPeer(null);
      return;
    }
    let current = true;
    setPeer('loading');
    loadPeerAverage({ sessionId, tool: peerTool, lastAt: peerLastAt }, timezone)
      .then(result => { if (current) setPeer(result); })
      .catch(() => { if (current) setPeer('failed'); });
    return () => { current = false; };
  }, [state.status, peerTool, peerLastAt, sessionId, timezone]);

  return { state, timeline, summary, peer };
}
