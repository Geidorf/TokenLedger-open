import { useEffect, useRef, useState } from 'react';
import type { Tab } from '../../types';

/**
 * 会话详情的入口地址：`#session/<工具>/<会话 ID>`，工具未知时写 `-`。
 * 会话按（工具，会话 ID）区分；请求日志按 agent 映射出工具键，只有工具确实
 * 未知时才传空工具，详情页再按会话 ID 精确匹配所有工具的记录。
 */
export interface SessionDetailRef {
  sessionId: string;
  tool: string | null;
}

const PREFIX = 'session/';
const ANY_TOOL = '-';
/** 扫描器给缺少会话 ID 的记录的占位值，不是真实会话。 */
const PLACEHOLDER_SESSION_IDS = new Set(['unknown_session']);

export function isRealSessionId(sessionId: string | null | undefined): sessionId is string {
  const trimmed = (sessionId ?? '').trim();
  return trimmed.length > 0 && !PLACEHOLDER_SESSION_IDS.has(trimmed);
}

export function sessionDetailHash(ref: SessionDetailRef): string {
  const tool = ref.tool?.trim() ? encodeURIComponent(ref.tool.trim()) : ANY_TOOL;
  return `#${PREFIX}${tool}/${encodeURIComponent(ref.sessionId)}`;
}

export function parseSessionDetailHash(hash: string | null | undefined): SessionDetailRef | null {
  const raw = (hash ?? '').replace(/^#/, '');
  if (!raw.startsWith(PREFIX)) return null;
  const rest = raw.slice(PREFIX.length);
  const slash = rest.indexOf('/');
  if (slash <= 0) return null;
  try {
    const toolPart = decodeURIComponent(rest.slice(0, slash));
    const sessionId = decodeURIComponent(rest.slice(slash + 1));
    if (!isRealSessionId(sessionId)) return null;
    return { sessionId, tool: toolPart === ANY_TOOL || !toolPart.trim() ? null : toolPart };
  } catch {
    return null;
  }
}

export function sameSessionRef(left: SessionDetailRef | null, right: SessionDetailRef | null): boolean {
  if (!left || !right) return left === right;
  return left.sessionId === right.sessionId && (left.tool ?? '').toLowerCase() === (right.tool ?? '').toLowerCase();
}

/**
 * 从任何页面打开会话详情（请求明细、会话排行、周报「最贵会话」、异常卡片、请求日志）。
 * 只改地址；`useSessionDetailRoute` 负责切到「用量 › 会话」并显示详情。
 */
export function openSessionDetail(ref: SessionDetailRef): void {
  if (!isRealSessionId(ref.sessionId)) return;
  const next = sessionDetailHash(ref);
  if (window.location.hash === next) {
    // 同一地址不会再触发 hashchange；补发一次让已离开详情的页面重新打开。
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    return;
  }
  window.location.hash = next;
}

/**
 * 关闭详情，不留一条会被「后退」重新打开的历史：返回列表时地址回到 `#sessions`，
 * 切到别的页面时去掉地址里的锚点。
 */
export function closeSessionDetail(next: '#sessions' | null = '#sessions'): void {
  if (!parseSessionDetailHash(window.location.hash)) return;
  window.history.replaceState(null, '', next ?? `${window.location.pathname}${window.location.search}`);
}

/**
 * 当前打开的会话详情。地址指向详情时切到「会话」子页；离开「会话」子页时收起详情，
 * 之后从侧栏回到「会话」看到的是列表而不是上一次的详情。
 */
export function useSessionDetailRoute(activeTab: Tab, changeTab: (tab: Tab) => void) {
  const [ref, setRef] = useState<SessionDetailRef | null>(() => parseSessionDetailHash(typeof window === 'undefined' ? '' : window.location.hash));
  const changeTabRef = useRef(changeTab);
  changeTabRef.current = changeTab;

  useEffect(() => {
    const follow = () => {
      const next = parseSessionDetailHash(window.location.hash);
      setRef(current => (sameSessionRef(current, next) ? current : next));
      if (next) changeTabRef.current('behavior');
    };
    follow();
    window.addEventListener('hashchange', follow);
    return () => window.removeEventListener('hashchange', follow);
  }, []);

  const previousTab = useRef(activeTab);
  useEffect(() => {
    const left = previousTab.current === 'behavior' && activeTab !== 'behavior';
    previousTab.current = activeTab;
    if (left && ref) {
      closeSessionDetail(null);
      setRef(null);
    }
  }, [activeTab, ref]);

  const close = () => {
    closeSessionDetail();
    setRef(null);
  };

  return { ref, close };
}
