import { Layers } from 'lucide-react';
import type { ContextCompositionTotals, RequestContext } from '../../types';
import { formatNum } from '../../utils/format';
import { ContextCompositionBar } from './ContextComposition';
import { useT } from '../../i18n';

const average = (value: number, requests: number) => (Number.isFinite(value) && value > 0 ? value / requests : 0);
const oneDecimal = (value: number) => value.toLocaleString('zh-CN', { maximumFractionDigits: 1 });

/**
 * 概览「平均 Context 构成」（契约 §2.8）：本期带构成的网关请求，平均每次请求的输入由哪些部分组成。
 * 只有本机网关记下构成时才有；其他来源没有请求体，不推算。
 */
export function AverageContextPanel({ totals }: { totals: ContextCompositionTotals | undefined }) {
  const t = useT();
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
    t('context.avg.messages', { count: oneDecimal(context.messages) }),
    context.toolResults > 0 ? t('context.toolResults', { count: oneDecimal(context.toolResults) }) : '',
    context.attachments > 0 ? t('context.attachments', { count: oneDecimal(context.attachments) }) : '',
    t('context.avg.basis', { count: formatNum(requests) }),
  ].filter(Boolean).join(' · ');
  return (
    <section className="panel average-context-panel" aria-label={t('context.avg.title')}>
      <div className="panel-header">
        <div className="panel-title">
          <span className="panel-icon" aria-hidden="true"><Layers className="h-4 w-4" /></span>
          <span>{t('context.avg.title')}</span>
        </div>
      </div>
      <ContextCompositionBar
        context={context}
        promptTokens={average(totals.promptTokens, requests)}
        title={t('context.avg.barTitle')}
        counts={counts}
      />
    </section>
  );
}
