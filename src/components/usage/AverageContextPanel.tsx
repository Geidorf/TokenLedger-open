import { Layers } from 'lucide-react';
import type { ContextCompositionTotals, RequestContext } from '../../types';
import { formatNum } from '../../utils/format';
import { ContextCompositionBar } from './ContextComposition';

const average = (value: number, requests: number) => (Number.isFinite(value) && value > 0 ? value / requests : 0);
const oneDecimal = (value: number) => value.toLocaleString('zh-CN', { maximumFractionDigits: 1 });

/**
 * 概览「平均 Context 构成」（契约 §2.8）：本期带构成的网关请求，平均每次请求的输入由哪些部分组成。
 * 只有本机网关记下构成时才有；其他来源没有请求体，不推算。
 */
export function AverageContextPanel({ totals }: { totals: ContextCompositionTotals | undefined }) {
  const requests = totals?.requests ?? 0;
  if (!totals || !Number.isFinite(requests) || requests <= 0) return null;
  const context: RequestContext = {
    systemBytes: average(totals.systemBytes, requests),
    toolsBytes: average(totals.toolsBytes, requests),
    historyBytes: average(totals.historyBytes, requests),
    toolResultsBytes: average(totals.toolResultsBytes, requests),
    attachmentsBytes: average(totals.attachmentsBytes, requests),
    messages: average(totals.messages, requests),
    toolResults: average(totals.toolResults, requests),
    attachments: average(totals.attachments, requests),
  };
  const counts = [
    `平均 ${oneDecimal(context.messages)} 条消息`,
    context.toolResults > 0 ? `${oneDecimal(context.toolResults)} 个工具结果` : '',
    context.attachments > 0 ? `${oneDecimal(context.attachments)} 个附件` : '',
    `基于 ${formatNum(requests)} 次经网关的请求`,
  ].filter(Boolean).join(' · ');
  return (
    <section className="panel average-context-panel" aria-label="平均 Context 构成">
      <div className="panel-header">
        <div className="panel-title">
          <span className="panel-icon" aria-hidden="true"><Layers className="h-4 w-4" /></span>
          <span>平均 Context 构成</span>
        </div>
      </div>
      <ContextCompositionBar
        context={context}
        promptTokens={average(totals.promptTokens, requests)}
        title="每次请求平均输入 · 估算（按请求体字节占比分摊输入 Token）"
        counts={counts}
      />
    </section>
  );
}
