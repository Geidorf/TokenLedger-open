import type { RequestContext } from '../types';

/**
 * 逐请求 Context 构成（契约 §2.5 可选 `context`）：网关只记各部分序列化后的字节数与条数，不留内容。
 * 字节数是实测；估算 Token 按字节占比分摊这次请求实测的输入合计（输入 + 缓存读写），
 * 分词器因模型而异，界面须标「估算」。
 */
export const CONTEXT_SEGMENTS = [
  { key: 'systemBytes', label: '系统提示' },
  { key: 'toolsBytes', label: '工具定义' },
  { key: 'historyBytes', label: '对话历史' },
  { key: 'toolResultsBytes', label: '工具结果' },
  { key: 'attachmentsBytes', label: '附件' },
] as const;

export type ContextSegmentKey = (typeof CONTEXT_SEGMENTS)[number]['key'];

export interface ContextSegment {
  key: ContextSegmentKey;
  label: string;
  bytes: number;
  share: number;
  /** 按字节占比分摊的估算 Token；没有实测输入时为 null。 */
  estimatedTokens: number | null;
}

const count = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0);

/** 只返回字节数为正的分段；没有构成或全为 0 时返回 null。 */
export function contextComposition(context: RequestContext | undefined, promptTokens: number): ContextSegment[] | null {
  if (!context) return null;
  const sized = CONTEXT_SEGMENTS.map(({ key, label }) => ({ key, label, bytes: count(context[key]) }));
  const total = sized.reduce((sum, segment) => sum + segment.bytes, 0);
  if (total <= 0) return null;
  const tokens = count(promptTokens);
  return sized
    .filter((segment) => segment.bytes > 0)
    .map((segment) => ({
      ...segment,
      share: segment.bytes / total,
      estimatedTokens: tokens > 0 ? Math.round((tokens * segment.bytes) / total) : null,
    }));
}
