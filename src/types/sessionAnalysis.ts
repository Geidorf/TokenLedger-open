import { localized, t } from '../i18n';

/** 本机按需分析投影；不属于 Stats、持久账本或云端契约。 */
export interface SessionTurn {
  id: string;
  ordinal: number;
  startedAt: string | null;
  endedAt: string | null;
  status: 'complete' | 'in_progress' | 'unknown';
  requestCount: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  models: string[];
  tools: { name: string; count: number }[];
}

export interface SessionAnalysis {
  status: 'ready' | 'partial' | 'unavailable';
  reason?: string;
  recordId: number;
  sessionId: string;
  tool: string;
  observedAt: string;
  turns: SessionTurn[];
  unassignedUsage?: Pick<SessionTurn, 'requestCount' | 'inputTokens' | 'outputTokens' | 'cachedTokens'>;
  coverage: { complete: boolean; matchedRecord: boolean; toolCallsKnown: boolean };
}

export interface SessionAnalysisRecord {
  id: number;
  sessionId: string;
  tool: string;
}

const REASONS: Record<string, string> = localized({
  record_not_found: 'session.reason.recordNotFound',
  unsupported_source: 'session.reason.unsupportedSource',
  source_missing: 'session.reason.sourceMissing',
  source_changed: 'session.reason.sourceChanged',
  source_ambiguous: 'session.reason.sourceAmbiguous',
  insufficient_turn_metadata: 'session.reason.insufficientTurnMetadata',
  unsupported_session_shape: 'session.reason.unsupportedSessionShape',
  limit_exceeded: 'session.reason.limitExceeded',
  cancelled: 'session.reason.cancelled',
  invalid_request: 'session.reason.invalidRequest',
  source_unreadable: 'session.reason.sourceUnreadable',
});

export function sessionAnalysisReason(reason?: string): string {
  return (reason && REASONS[reason]) || t('session.reason.fallback');
}
