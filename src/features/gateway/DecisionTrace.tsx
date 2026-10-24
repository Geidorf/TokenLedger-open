import { TRACE_VERDICT_LABEL, traceReasonLabel } from './helpers';
import type { MemberTrace, RouteDecision } from './types';
import './decisionTrace.css';
import { t } from '../../i18n';

function verdictTone(verdict: string): string {
  if (verdict === 'chosen') return 'is-success';
  if (verdict === 'failed' || verdict === 'rejected') return 'is-warning';
  return '';
}

/**
 * Why each member of a routing group was chosen or passed over for one
 * request. Decisions recorded before the trace existed fall back to their
 * attempts, which only cover the members actually tried.
 */
export function DecisionTrace({ decision }: { decision: RouteDecision }) {
  const trace: MemberTrace[] = decision.trace?.length
    ? decision.trace
    : decision.attempts.map((attempt, index) => ({
      member: attempt.member,
      rank: index,
      verdict: attempt.outcome === 'ok' ? 'chosen' : attempt.outcome,
      reasons: [],
      detail: attempt.error ?? null,
    }));
  if (trace.length === 0) return <p className="mw-caption">{t('trace.empty')}</p>;
  return (
    <ol className="mw-trace" aria-label={t('trace.aria', { group: decision.group })}>
      {trace.map((item) => (
        <li key={item.member} className={`mw-trace-item is-${item.verdict}`}>
          <span className="mw-trace-rank" aria-hidden="true">{item.rank == null ? '–' : item.rank + 1}</span>
          <span className="mw-mono-text mw-trace-member" title={item.member}>{item.member}</span>
          <span className={`mw-chip ${verdictTone(item.verdict)}`}>{TRACE_VERDICT_LABEL[item.verdict] ?? item.verdict}</span>
          {item.reasons.length > 0 && (
            <span className="mw-trace-reasons">{item.reasons.map(traceReasonLabel).join(' · ')}</span>
          )}
          {item.detail && <span className="mw-trace-detail" title={item.detail}>{item.detail}</span>}
        </li>
      ))}
    </ol>
  );
}

export default DecisionTrace;
