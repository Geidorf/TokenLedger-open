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

const REASONS: Record<string, string> = {
  record_not_found: '这条记录已不在本机账本中。',
  unsupported_source: '这个来源暂不支持逐轮分析。当前支持 Claude 与 Codex 主会话。',
  source_missing: '原始会话文件已清理或当前不可访问，账本中的用量记录仍然保留。',
  source_changed: '分析期间会话文件发生变化，请重新读取。',
  source_ambiguous: '发现内容不一致的会话副本，暂时无法确定可信来源。',
  insufficient_turn_metadata: '这份日志缺少可靠的用户轮次信息，无法按轮拆分。',
  unsupported_session_shape: '此会话包含分叉、子代理或无法确认的轮次结构，暂不支持分析。',
  limit_exceeded: '这份会话超过当前分析容量，未生成不完整的全会话结果。',
  cancelled: '分析已取消。',
  invalid_request: '无法识别这条本机会话记录，请重新打开。',
  source_unreadable: '当前无法读取原始会话文件，请确认本机文件可访问后重试。',
};

export function sessionAnalysisReason(reason?: string): string {
  return (reason && REASONS[reason]) || '暂时无法分析这份会话，请稍后重试。';
}
