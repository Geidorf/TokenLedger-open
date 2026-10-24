import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { ArrowDown, ArrowUp, Pencil, Plus, Split, Trash2 } from 'lucide-react';
import { EmptyState } from '../../components/EmptyState';
import { GroupIcon } from '../../prototypes/prototypeKit';
import type { ToastType } from '../../types';
import type { RequestConfirmation } from '../../utils/confirmation';
import { deleteRoutingGroup, errorText, listProviders, listRoutingGroups, recentRouteDecisions, routingCooldowns, upsertRoutingGroup } from './api';
import {
  ATTEMPT_OUTCOME_LABEL,
  DECISION_REASON_LABEL,
  decisionDetail,
  defaultCondition,
  MAX_WEIGHT,
  memberWeight,
  modelOptions,
  RULE_KIND_LABEL,
  ruleSummary,
  shortTime,
  slugId,
  STRATEGY_HINT,
  STRATEGY_LABEL,
  TTL_OPTIONS,
  ttlLabel,
  weightShare,
} from './helpers';
import type { CoolingMember, ProviderView, RouteDecision, RoutingGroup, RoutingRule, RoutingStrategy, RuleCondition, RuleKind } from './types';
import { Sheet } from './ui';
import { InfoTip } from '../../components/InfoTip';
import { RoutingStage, RoutingStageEmpty } from './RoutingStage';
import { DecisionTrace } from './DecisionTrace';
import { readExternalGateway, useRoutingLive } from './useRoutingLive';
import { t, useLang } from '../../i18n';

interface PageProps {
  onNotify: (type: ToastType, text: string) => void;
  onConfirm: RequestConfirmation;
}

const STRATEGIES = Object.keys(STRATEGY_LABEL) as RoutingStrategy[];
const RULE_KINDS = Object.keys(RULE_KIND_LABEL) as RuleKind[];

function splitList(text: string): string[] {
  return text.split(/[\s,\uff0c]+/).map((item) => item.trim()).filter(Boolean);
}

function ConditionFields({ condition, onChange }: { condition: RuleCondition; onChange: (next: RuleCondition) => void }) {
  switch (condition.kind) {
    case 'inputCharsOver':
      return <input type="number" min={1} aria-label={t('routing.cond.chars')} value={condition.chars} onChange={(event) => onChange({ kind: 'inputCharsOver', chars: Math.max(1, Number(event.target.value) || 1) })} />;
    case 'reasoningEffort':
      return <input aria-label={t('routing.ruleKind.reasoningEffort')} value={condition.efforts.join(',')} onChange={(event) => onChange({ kind: 'reasoningEffort', efforts: splitList(event.target.value) })} placeholder="high,xhigh" />;
    case 'agent':
      return <input aria-label="Agent" value={condition.agents.join(',')} onChange={(event) => onChange({ kind: 'agent', agents: splitList(event.target.value) })} placeholder="codex" />;
    case 'timeWindow':
      return (
        <>
          <input type="time" aria-label={t('routing.cond.start')} value={condition.start} onChange={(event) => onChange({ ...condition, start: event.target.value })} />
          <span className="mw-faint">{t('routing.cond.to')}</span>
          <input type="time" aria-label={t('routing.cond.end')} value={condition.end} onChange={(event) => onChange({ ...condition, end: event.target.value })} />
        </>
      );
    default:
      return null;
  }
}

function GroupEditor({ initial, isNew, options, busy, onSave }: {
  initial: RoutingGroup;
  isNew: boolean;
  options: { value: string; section: string }[];
  busy: boolean;
  onSave: (group: RoutingGroup) => void;
}) {
  const [group, setGroup] = useState(initial);
  const [candidate, setCandidate] = useState('');
  const set = (patch: Partial<RoutingGroup>) => setGroup((current) => ({ ...current, ...patch }));
  // Subgroups are allowed; cycles and depth are checked when saving.
  const available = options.filter((option) => option.value !== `group/${group.id}` && !group.members.includes(option.value));

  const setWeight = (member: string, value: number) => set({
    weights: { ...group.weights, [member]: Math.min(MAX_WEIGHT, Math.max(1, Math.round(value) || 1)) },
  });
  const removeMember = (member: string) => set({
    members: group.members.filter((item) => item !== member),
    weights: Object.fromEntries(Object.entries(group.weights ?? {}).filter(([key]) => key !== member)),
    rules: group.rules.filter((rule) => rule.member !== member),
    manualMember: group.manualMember === member ? null : group.manualMember,
  });
  const move = (index: number, delta: number) => {
    const members = [...group.members];
    const [item] = members.splice(index, 1);
    members.splice(index + delta, 0, item);
    set({ members });
  };
  const setRule = (index: number, rule: RoutingRule) => set({ rules: group.rules.map((item, i) => (i === index ? rule : item)) });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const { weights: _weights, ...rest } = group;
    const next: RoutingGroup = { ...rest, name: group.name.trim(), manualMember: group.strategy === 'manual' ? group.manualMember ?? group.members[0] ?? null : null };
    if (group.strategy === 'weighted') {
      next.weights = Object.fromEntries(group.members.filter((member) => memberWeight(group, member) !== 1).map((member) => [member, memberWeight(group, member)]));
    }
    onSave(next);
  };

  return (
    <form className="mw-editor" onSubmit={submit}>
      <label className="mw-field"><span>{t('routing.editor.name')}</span><input value={group.name} onChange={(event) => set({ name: event.target.value })} required /></label>
      {isNew && <label className="mw-field"><span>ID</span><input value={group.id} onChange={(event) => set({ id: event.target.value })} required /><small>{t('routing.editor.idHint', { id: group.id || 'ID' })}</small></label>}
      <label className="mw-field">
        <span>{t('routing.editor.strategy')}</span>
        <select className="mw-native-select" value={group.strategy} onChange={(event) => set({ strategy: event.target.value as RoutingStrategy })}>
          {STRATEGIES.map((strategy) => <option key={strategy} value={strategy}>{STRATEGY_LABEL[strategy]}</option>)}
        </select>
        <small>{STRATEGY_HINT[group.strategy]}</small>
      </label>

      <section className="mw-field">
        <span>{t('routing.editor.members')}</span>
        {group.members.length === 0 && <small>{t('routing.editor.membersEmpty')}</small>}
        <ol className="mw-members">
          {group.members.map((member, index) => (
            <li key={member}>
              <span className="mw-member-n">{index + 1}</span>
              <div className="mw-member-main"><strong className="mw-mono-text">{member}</strong></div>
              {group.strategy === 'manual' && (
                <button type="button" role="radio" aria-checked={group.manualMember === member} aria-label={t('routing.editor.onlyUse', { member })} className={`mw-radio ${group.manualMember === member ? 'is-on' : ''}`} onClick={() => set({ manualMember: member })}><span /></button>
              )}
              {group.strategy === 'weighted' && (
                <label className="mw-weight">
                  <input type="number" min={1} max={MAX_WEIGHT} aria-label={t('routing.editor.weightOf', { member })} value={memberWeight(group, member)} onChange={(event) => setWeight(member, Number(event.target.value))} />
                  <span className="mw-faint">{weightShare(group, member)}%</span>
                </label>
              )}
              <button type="button" className="mw-icon-btn" aria-label={t('routing.editor.moveUp', { member })} disabled={index === 0} onClick={() => move(index, -1)}><ArrowUp className="h-3.5 w-3.5" /></button>
              <button type="button" className="mw-icon-btn" aria-label={t('routing.editor.moveDown', { member })} disabled={index === group.members.length - 1} onClick={() => move(index, 1)}><ArrowDown className="h-3.5 w-3.5" /></button>
              <button type="button" className="mw-icon-btn" aria-label={t('routing.editor.remove', { member })} onClick={() => removeMember(member)}><Trash2 className="h-3.5 w-3.5" /></button>
            </li>
          ))}
        </ol>
        <div className="mw-editor-row">
          <select className="mw-native-select is-compact" aria-label={t('routing.editor.pickMember')} value={candidate} onChange={(event) => setCandidate(event.target.value)}>
            <option value="">{t('routing.editor.pickMemberPlaceholder')}</option>
            {available.map((option) => <option key={option.value} value={option.value}>{option.value}</option>)}
          </select>
          <button type="button" className="mw-btn is-ghost" disabled={!candidate} onClick={() => { set({ members: [...group.members, candidate] }); setCandidate(''); }}><Plus className="h-3.5 w-3.5" />{t('routing.editor.addMember')}</button>
        </div>
      </section>

      <section className="mw-field">
        <span>{t(group.strategy === 'manual' ? 'routing.editor.rulesPaused' : 'routing.editor.rules')}</span>
        <small>{t('routing.editor.rulesHint')}</small>
        {group.rules.map((rule, index) => (
          <div key={index} className="mw-rule-edit">
            <span>{t('routing.editor.when')}</span>
            <select className="mw-native-select is-compact" aria-label={t('routing.editor.ruleCondition')} value={rule.condition.kind} onChange={(event) => setRule(index, { ...rule, condition: defaultCondition(event.target.value as RuleKind) })}>
              {RULE_KINDS.map((kind) => <option key={kind} value={kind}>{RULE_KIND_LABEL[kind]}</option>)}
            </select>
            <ConditionFields condition={rule.condition} onChange={(condition) => setRule(index, { ...rule, condition })} />
            <span>{t('routing.editor.useFirst')}</span>
            <select className="mw-native-select is-compact" aria-label={t('routing.editor.ruleMember')} value={rule.member} onChange={(event) => setRule(index, { ...rule, member: event.target.value })}>
              {group.members.map((member) => <option key={member} value={member}>{member}</option>)}
            </select>
            <button type="button" className="mw-icon-btn" aria-label={t('routing.editor.deleteRule')} onClick={() => set({ rules: group.rules.filter((_, i) => i !== index) })}><Trash2 className="h-3.5 w-3.5" /></button>
          </div>
        ))}
        <div className="mw-editor-row">
          <button type="button" className="mw-btn is-ghost" disabled={group.members.length === 0} onClick={() => set({ rules: [...group.rules, { condition: defaultCondition('hasImage'), member: group.members[0] }] })}><Plus className="h-3.5 w-3.5" />{t('routing.editor.addRule')}</button>
        </div>
      </section>

      <label className="mw-field">
        <span>{t('routing.editor.affinity')}</span>
        <select className="mw-native-select" value={group.sessionTtlSecs} onChange={(event) => set({ sessionTtlSecs: Number(event.target.value) })}>
          {TTL_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          {!TTL_OPTIONS.some((option) => option.value === group.sessionTtlSecs) && <option value={group.sessionTtlSecs}>{ttlLabel(group.sessionTtlSecs)}</option>}
        </select>
        <small>{t('routing.editor.affinityHint')}</small>
      </label>

      <div className="mw-form-actions">
        <button type="submit" className="mw-btn is-primary" disabled={busy || group.members.length === 0}>{busy ? t('routing.editor.saving') : t('routing.editor.save')}</button>
      </div>
    </form>
  );
}

function coolingLabel(item: CoolingMember): string {
  const time = item.remainingSecs >= 60
    ? t('routing.cooling.minutes', { count: Math.ceil(item.remainingSecs / 60) })
    : t('routing.cooling.seconds', { count: item.remainingSecs });
  return t('routing.cooling.label', { time });
}

function GroupCard({ group, busy, cooling, onEdit, onToggle, onDelete }: { group: RoutingGroup; busy: boolean; cooling: Map<string, CoolingMember>; onEdit: () => void; onToggle: () => void; onDelete: () => void }) {
  return (
    <div className={`mw-card mw-group ${group.enabled ? '' : 'is-off'}`}>
      <div className="mw-group-head">
        <GroupIcon size={28} />
        <div className="mw-group-title"><strong>{group.name}</strong><span className="mw-mono-text">group/{group.id}</span></div>
        <span className="mw-chip">{STRATEGY_LABEL[group.strategy]}</span>
        <span className="mw-flex" />
        <button type="button" className="mw-icon-btn" aria-label={t('routing.card.edit', { name: group.name })} onClick={onEdit}><Pencil className="h-3.5 w-3.5" /></button>
        <button type="button" className="mw-icon-btn" aria-label={t('routing.card.delete', { name: group.name })} disabled={busy} onClick={onDelete}><Trash2 className="h-3.5 w-3.5" /></button>
        <button type="button" role="switch" aria-checked={group.enabled} aria-label={t('routing.card.enable', { name: group.name })} disabled={busy} className={`mw-switch ${group.enabled ? 'is-on' : ''}`} onClick={onToggle}><span /></button>
      </div>
      <ol className="mw-members">
        {group.members.map((member, index) => (
          <li key={member}>
            <span className="mw-member-n">{index + 1}</span>
            <div className="mw-member-main"><strong className="mw-mono-text">{member}</strong></div>
            {group.strategy === 'manual' && group.manualMember === member && <span className="mw-chip is-success">{t('routing.card.pinned')}</span>}
            {group.strategy === 'weighted' && <span className="mw-chip">{t('routing.card.weight', { weight: memberWeight(group, member), share: weightShare(group, member) })}</span>}
            {cooling.has(member) && <span className="mw-chip is-warning" title={t('routing.cooling.failures', { count: cooling.get(member)?.failures ?? 0 })}>{coolingLabel(cooling.get(member) as CoolingMember)}</span>}
          </li>
        ))}
      </ol>
      {group.rules.length > 0 && (
        <div className={`mw-rules ${group.strategy === 'manual' ? 'is-paused' : ''}`}>
          {group.rules.map((rule, index) => (
            <div key={index} className="mw-rule">
              <span className="mw-rule-when">{t('routing.editor.when')} <b>{ruleSummary(rule.condition)}</b></span>
              <span className="mw-rule-arrow">{t('routing.editor.useFirst')}</span>
              <span className="mw-rule-use mw-mono-text">{rule.member}</span>
            </div>
          ))}
        </div>
      )}
      <div className="mw-group-foot">
        <span className="mw-foot-item">{t('routing.card.affinity', { ttl: ttlLabel(group.sessionTtlSecs) })}</span>
      </div>
    </div>
  );
}

function LiveRoutingCard() {
  const { scene, loaded } = useRoutingLive({ readExternal: readExternalGateway });
  const live = scene.sources.some((source) => source.reachable);
  return (
    <section className="mw-card rs-card" aria-label={t('routing.live.title')}>
      <div className="mw-panel-head rs-card-head">
        <h2>{t('routing.live.title')}</h2>
        <span className={`rs-livedot ${live ? 'is-on' : ''}`} aria-hidden="true" />
        <span className="mw-caption">{t(live ? 'routing.live.caption' : 'routing.live.disconnected')}</span>
        <span className="mw-flex" />
        {scene.empty === null && (
          <dl className="rs-stats" aria-label={t('routing.live.stats')}>
            <div><dt>{t('routing.live.inflight')}</dt><dd>{scene.stats.inflight}</dd></div>
            <div><dt>{t('routing.live.rerouted')}</dt><dd>{scene.stats.rerouted}</dd></div>
            <div><dt>{t('routing.live.failed')}</dt><dd>{scene.stats.failed}</dd></div>
          </dl>
        )}
      </div>
      {!loaded ? null : scene.empty ? <RoutingStageEmpty scene={scene} /> : <RoutingStage scene={scene} />}
    </section>
  );
}

function DecisionList({ decisions }: { decisions: RouteDecision[] }) {
  if (decisions.length === 0) return <p className="mw-caption">{t('routing.decisions.empty')}</p>;
  return (
    <ul>
      {decisions.map((decision) => (
        <li key={`${decision.requestId}-${decision.ts}`}>
          <div className="mw-decision-top">
            <span className="mw-decision-time">{shortTime(decision.ts)}</span>
            <span className="mw-mono-text mw-decision-identity" tabIndex={0} title={`group/${decision.group}`}>group/{decision.group}</span>
            <span className="mw-faint">→</span>
            <strong className="mw-mono-text mw-decision-identity" tabIndex={0} title={decision.chosen ?? undefined}>{decision.chosen ?? t('routing.decisions.noMember')}</strong>
          </div>
          <div className="mw-decision-why">
            <span className="mw-chip">{DECISION_REASON_LABEL[decision.reason] ?? decision.reason}</span>
            {decisionDetail(decision) && <span>{decision.detail}</span>}
          </div>
          {decision.attempts.length > 1 && (
            <div className="mw-decision-attempts">
              {decision.attempts.map((attempt, index) => (
                <span key={index} className={`mw-chip ${attempt.outcome === 'ok' ? 'is-success' : attempt.outcome === 'failed' ? 'is-warning' : ''}`} tabIndex={0} title={[attempt.member, attempt.error].filter(Boolean).join(' · ')}>
                  {attempt.member} · {ATTEMPT_OUTCOME_LABEL[attempt.outcome] ?? attempt.outcome}{attempt.status ? ` ${attempt.status}` : ''}
                </span>
              ))}
            </div>
          )}
          {decision.trace && decision.trace.length > 0 && (
            <details className="mw-trace-toggle">
              <summary>{t('routing.decisions.why', { count: decision.trace.length })}</summary>
              <DecisionTrace decision={decision} />
            </details>
          )}
        </li>
      ))}
    </ul>
  );
}

export function RoutingPage({ onNotify, onConfirm }: PageProps) {
  const [groups, setGroups] = useState<RoutingGroup[] | null>(null);
  const [providers, setProviders] = useState<ProviderView[]>([]);
  const [decisions, setDecisions] = useState<RouteDecision[]>([]);
  const [cooling, setCooling] = useState<CoolingMember[]>([]);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<{ group: RoutingGroup; isNew: boolean } | null>(null);
  // Labels here read the current language directly; subscribing re-renders the page when it changes.
  const lang = useLang();

  const load = useCallback(async () => {
    try {
      const [nextGroups, nextProviders, nextDecisions, nextCooling] = await Promise.all([listRoutingGroups(), listProviders(), recentRouteDecisions(30), routingCooldowns()]);
      setGroups(nextGroups);
      setProviders(nextProviders);
      setDecisions(nextDecisions);
      setCooling(nextCooling);
      setLoadError('');
    } catch (error) {
      setLoadError(errorText(error));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);
  // Members start and stop cooling without any page action, so keep polling
  // (faster while some are shown) and skip ticks while the window is hidden.
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      routingCooldowns().then(setCooling).catch(() => undefined);
    }, cooling.length > 0 ? 10_000 : 30_000);
    return () => window.clearInterval(timer);
  }, [cooling.length]);
  const coolingByMember = useMemo(() => new Map(cooling.map((item) => [item.member, item])), [cooling]);

  // eslint-disable-next-line react-hooks/exhaustive-deps -- `lang` re-derives the translated section labels
  const options = useMemo(() => modelOptions(providers, groups ?? []), [providers, groups, lang]);

  const save = async (group: RoutingGroup, success: string) => {
    setBusy(true);
    try {
      setGroups(await upsertRoutingGroup(group));
      onNotify('success', success);
      return true;
    } catch (error) {
      onNotify('error', errorText(error));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const remove = async (group: RoutingGroup) => {
    const confirmed = await onConfirm({ title: t('routing.delete.title', { name: group.name }), description: t('routing.delete.description', { id: group.id }), confirmLabel: t('routing.delete.confirm'), tone: 'danger' });
    if (!confirmed) return;
    setBusy(true);
    try {
      setGroups(await deleteRoutingGroup(group.id));
      onNotify('success', t('routing.toast.deleted', { name: group.name }));
    } catch (error) {
      onNotify('error', errorText(error));
    } finally {
      setBusy(false);
    }
  };

  const createNew = () => setEditing({
    isNew: true,
    group: { id: slugId('group', groups?.map((item) => item.id) ?? []), name: '', strategy: 'failover', members: [], manualMember: null, rules: [], sessionTtlSecs: 3600, enabled: true },
  });

  return (
    <div className="mw-routing">
      <div className="mw-routing-main">
        <LiveRoutingCard />
        <div className="mw-toolbar">
          <span className="mw-caption">
            {t('routing.toolbar.count', { count: groups?.length ?? 0 })}
            <InfoTip label={t('routing.toolbar.info')}>
              <span>{t('routing.toolbar.infoCatalog')}</span>
              <span>{t('routing.toolbar.infoFailover')}</span>
            </InfoTip>
          </span>
          <button type="button" className="mw-btn is-primary" disabled={options.length === 0} title={options.length === 0 ? t('routing.toolbar.needProviders') : undefined} onClick={createNew}><Plus className="h-4 w-4" />{t('routing.toolbar.new')}</button>
        </div>
        {loadError && <p className="mw-note is-danger" role="alert">{t('routing.loadError', { error: loadError })}</p>}
        {groups && groups.length === 0 && (
          <EmptyState
            icon={Split}
            title={t('empty.routing.title')}
            description={t(options.length === 0 ? 'empty.routing.needProviders' : 'empty.routing.description')}
          >
            {options.length > 0 && <button type="button" className="mw-btn is-primary" onClick={createNew}><Plus className="h-4 w-4" />{t('empty.routing.action')}</button>}
          </EmptyState>
        )}
        {groups?.map((group) => (
          <GroupCard
            key={group.id}
            group={group}
            busy={busy}
            cooling={coolingByMember}
            onEdit={() => setEditing({ group, isNew: false })}
            onToggle={() => void save({ ...group, enabled: !group.enabled }, t(group.enabled ? 'routing.toast.disabled' : 'routing.toast.enabled', { name: group.name }))}
            onDelete={() => void remove(group)}
          />
        ))}
      </div>
      <section className="mw-card mw-decisions" aria-label={t('routing.decisions.region')}>
        <div className="mw-panel-head"><h2>{t('routing.decisions.title')}</h2><button type="button" className="mw-btn is-ghost" onClick={() => void load()}>{t('routing.decisions.refresh')}</button></div>
        {cooling.length > 0 && (
          <section className="mw-cooling" aria-label={t('routing.cooling.region')}>
            <h3>{t('routing.cooling.title')}</h3>
            <ul>
              {cooling.map((item) => (
                <li key={item.member}><span className="mw-mono-text">{item.member}</span><span className="mw-chip is-warning">{coolingLabel(item)}</span></li>
              ))}
            </ul>
            <small>{t('routing.cooling.hint')}</small>
          </section>
        )}
        <DecisionList decisions={decisions} />
      </section>
      {editing && (
        <Sheet title={editing.isNew ? t('routing.toolbar.new') : editing.group.name} subtitle={editing.isNew ? t('routing.sheet.newSubtitle') : `group/${editing.group.id}`} icon={<GroupIcon size={36} />} onClose={() => setEditing(null)}>
          <GroupEditor
            key={editing.group.id}
            initial={editing.group}
            isNew={editing.isNew}
            options={options}
            busy={busy}
            onSave={(group) => void save(group, t(editing.isNew ? 'routing.toast.created' : 'routing.toast.saved', { name: group.name })).then((ok) => { if (ok) setEditing(null); })}
          />
        </Sheet>
      )}
    </div>
  );
}

export default RoutingPage;
