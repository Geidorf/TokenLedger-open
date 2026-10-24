import type { LogHistoryItem, RequestContext } from '../../types';
import { formatNum } from '../../utils/format';
import { contextComposition } from '../../utils/contextComposition';

const percent = (share: number) => `${(share * 100).toFixed(share >= 0.1 ? 0 : 1)}%`;

interface ContextCompositionBarProps {
  context: RequestContext;
  promptTokens: number;
  title: string;
  /** 条数说明（消息、工具结果、附件），由调用方按单条或平均格式化。 */
  counts: string;
}

/** 按分段着色的横条与各段估算 Token；悬停给出实测字节数。没有构成时不渲染。 */
export function ContextCompositionBar({ context, promptTokens, title, counts }: ContextCompositionBarProps) {
  const segments = contextComposition(context, promptTokens);
  if (!segments) return null;
  return (
    <div className="log-detail-context">
      <span>{title}</span>
      <div className="log-context-bar" role="img" aria-label={segments.map((s) => `${s.label} ${percent(s.share)}`).join('，')}>
        {segments.map((segment) => (
          <i key={segment.key} className={`is-${segment.key}`} style={{ flexGrow: segment.share }} />
        ))}
      </div>
      <ul className="log-context-legend">
        {segments.map((segment) => (
          <li key={segment.key} title={`实测 ${formatNum(segment.bytes)} 字节`}>
            <i className={`is-${segment.key}`} aria-hidden="true" />
            {segment.label}
            <b>{segment.estimatedTokens === null ? percent(segment.share) : `≈${formatNum(segment.estimatedTokens)}`}</b>
            {segment.estimatedTokens !== null && <small>{percent(segment.share)}</small>}
          </li>
        ))}
      </ul>
      {counts && <small className="log-context-counts">{counts}</small>}
    </div>
  );
}

/**
 * 请求展开行里的「Context 构成」：只有网关记下构成的行才显示。
 */
export function ContextComposition({ log }: { log: LogHistoryItem }) {
  const context = log.context;
  if (!context) return null;
  const counts = [
    `${formatNum(context.messages)} 条消息`,
    context.toolResults > 0 ? `${formatNum(context.toolResults)} 个工具结果` : '',
    context.attachments > 0 ? `${formatNum(context.attachments)} 个附件` : '',
  ].filter(Boolean).join(' · ');
  return (
    <ContextCompositionBar
      context={context}
      promptTokens={(log.inputTokens || 0) + (log.cachedTokens || 0)}
      title="Context 构成 · 估算（按请求体字节占比分摊输入 Token）"
      counts={counts}
    />
  );
}
