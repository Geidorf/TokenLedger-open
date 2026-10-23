import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { ArrowDown, ArrowUp, Pencil, Plus, Trash2 } from 'lucide-react';
import { GroupIcon } from '../../prototypes/prototypeKit';
import type { ToastType } from '../../types';
import type { RequestConfirmation } from '../../utils/confirmation';
import { deleteRoutingGroup, errorText, listProviders, listRoutingGroups, recentRouteDecisions, upsertRoutingGroup } from './api';
import {
  ATTEMPT_OUTCOME_LABEL,
  DECISION_REASON_LABEL,
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
import type { ProviderView, RouteDecision, RoutingGroup, RoutingRule, RoutingStrategy, RuleCondition, RuleKind } from './types';
import { Sheet } from './ui';
import { InfoTip } from '../../components/InfoTip';
import { RoutingStage, RoutingStageEmpty } from './RoutingStage';
import { readExternalGateway, useRoutingLive } from './useRoutingLive';

interface PageProps {
  onNotify: (type: ToastType, text: string) => void;
  onConfirm: RequestConfirmation;
}

const STRATEGIES = Object.keys(STRATEGY_LABEL) as RoutingStrategy[];
const RULE_KINDS = Object.keys(RULE_KIND_LABEL) as RuleKind[];

function splitList(text: string): string[] {
  return text.split(/[\s,，]+/).map((item) => item.trim()).filter(Boolean);
}

function ConditionFields({ condition, onChange }: { condition: RuleCondition; onChange: (next: RuleCondition) => void }) {
  switch (condition.kind) {
    case 'inputCharsOver':
      return <input type="number" min={1} aria-label="字符数" value={condition.chars} onChange={(event) => onChange({ kind: 'inputCharsOver', chars: Math.max(1, Number(event.target.value) || 1) })} />;
    case 'reasoningEffort':
      return <input aria-label="推理强度" value={condition.efforts.join(',')} onChange={(event) => onChange({ kind: 'reasoningEffort', efforts: splitList(event.target.value) })} placeholder="high,xhigh" />;
    case 'agent':
      return <input aria-label="Agent" value={condition.agents.join(',')} onChange={(event) => onChange({ kind: 'agent', agents: splitList(event.target.value) })} placeholder="codex" />;
    case 'timeWindow':
      return (
        <>
          <input type="time" aria-label="开始时间" value={condition.start} onChange={(event) => onChange({ ...condition, start: event.target.value })} />
          <span className="mw-faint">至</span>
          <input type="time" aria-label="结束时间" value={condition.end} onChange={(event) => onChange({ ...condition, end: event.target.value })} />
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
  const available = options.filter((option) => !option.value.startsWith('group/') && !group.members.includes(option.value));

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
      <label className="mw-field"><span>名称</span><input value={group.name} onChange={(event) => set({ name: event.target.value })} required /></label>
      {isNew && <label className="mw-field"><span>ID</span><input value={group.id} onChange={(event) => set({ id: event.target.value })} required /><small>Agent 里写作 group/{group.id || 'ID'}，保存后不能改</small></label>}
      <label className="mw-field">
        <span>分配方式</span>
        <select className="mw-native-select" value={group.strategy} onChange={(event) => set({ strategy: event.target.value as RoutingStrategy })}>
          {STRATEGIES.map((strategy) => <option key={strategy} value={strategy}>{STRATEGY_LABEL[strategy]}</option>)}
        </select>
        <small>{STRATEGY_HINT[group.strategy]}</small>
      </label>

      <section className="mw-field">
        <span>成员（按优先顺序）</span>
        {group.members.length === 0 && <small>至少添加一个成员。</small>}
        <ol className="mw-members">
          {group.members.map((member, index) => (
            <li key={member}>
              <span className="mw-member-n">{index + 1}</span>
              <div className="mw-member-main"><strong className="mw-mono-text">{member}</strong></div>
              {group.strategy === 'manual' && (
                <button type="button" role="radio" aria-checked={group.manualMember === member} aria-label={`只用 ${member}`} className={`mw-radio ${group.manualMember === member ? 'is-on' : ''}`} onClick={() => set({ manualMember: member })}><span /></button>
              )}
              {group.strategy === 'weighted' && (
                <label className="mw-weight">
                  <input type="number" min={1} max={MAX_WEIGHT} aria-label={`${member} 的权重`} value={memberWeight(group, member)} onChange={(event) => setWeight(member, Number(event.target.value))} />
                  <span className="mw-faint">{weightShare(group, member)}%</span>
                </label>
              )}
              <button type="button" className="mw-icon-btn" aria-label={`上移 ${member}`} disabled={index === 0} onClick={() => move(index, -1)}><ArrowUp className="h-3.5 w-3.5" /></button>
              <button type="button" className="mw-icon-btn" aria-label={`下移 ${member}`} disabled={index === group.members.length - 1} onClick={() => move(index, 1)}><ArrowDown className="h-3.5 w-3.5" /></button>
              <button type="button" className="mw-icon-btn" aria-label={`移除 ${member}`} onClick={() => removeMember(member)}><Trash2 className="h-3.5 w-3.5" /></button>
            </li>
          ))}
        </ol>
        <div className="mw-editor-row">
          <select className="mw-native-select is-compact" aria-label="选择成员" value={candidate} onChange={(event) => setCandidate(event.target.value)}>
            <option value="">选择 供应商/模型…</option>
            {available.map((option) => <option key={option.value} value={option.value}>{option.value}</option>)}
          </select>
          <button type="button" className="mw-btn is-ghost" disabled={!candidate} onClick={() => { set({ members: [...group.members, candidate] }); setCandidate(''); }}><Plus className="h-3.5 w-3.5" />添加成员</button>
        </div>
      </section>

      <section className="mw-field">
        <span>规则{group.strategy === 'manual' ? '（固定一个时暂停）' : ''}</span>
        <small>一轮对话开始时按顺序判断，第一条命中的生效，优先于会话保持；其余成员留作后备。</small>
        {group.rules.map((rule, index) => (
          <div key={index} className="mw-rule-edit">
            <span>当</span>
            <select className="mw-native-select is-compact" aria-label="规则条件" value={rule.condition.kind} onChange={(event) => setRule(index, { ...rule, condition: defaultCondition(event.target.value as RuleKind) })}>
              {RULE_KINDS.map((kind) => <option key={kind} value={kind}>{RULE_KIND_LABEL[kind]}</option>)}
            </select>
            <ConditionFields condition={rule.condition} onChange={(condition) => setRule(index, { ...rule, condition })} />
            <span>→ 先用</span>
            <select className="mw-native-select is-compact" aria-label="规则成员" value={rule.member} onChange={(event) => setRule(index, { ...rule, member: event.target.value })}>
              {group.members.map((member) => <option key={member} value={member}>{member}</option>)}
            </select>
            <button type="button" className="mw-icon-btn" aria-label="删除规则" onClick={() => set({ rules: group.rules.filter((_, i) => i !== index) })}><Trash2 className="h-3.5 w-3.5" /></button>
          </div>
        ))}
        <div className="mw-editor-row">
          <button type="button" className="mw-btn is-ghost" disabled={group.members.length === 0} onClick={() => set({ rules: [...group.rules, { condition: defaultCondition('hasImage'), member: group.members[0] }] })}><Plus className="h-3.5 w-3.5" />添加规则</button>
        </div>
      </section>

      <label className="mw-field">
        <span>会话保持</span>
        <select className="mw-native-select" value={group.sessionTtlSecs} onChange={(event) => set({ sessionTtlSecs: Number(event.target.value) })}>
          {TTL_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          {!TTL_OPTIONS.some((option) => option.value === group.sessionTtlSecs) && <option value={group.sessionTtlSecs}>{ttlLabel(group.sessionTtlSecs)}</option>}
        </select>
        <small>同一会话在这段时间内固定用同一个成员；失败时仍会切换。</small>
      </label>

      <div className="mw-form-actions">
        <button type="submit" className="mw-btn is-primary" disabled={busy || group.members.length === 0}>{busy ? '保存中…' : '保存'}</button>
      </div>
    </form>
  );
}

function GroupCard({ group, busy, onEdit, onToggle, onDelete }: { group: RoutingGroup; busy: boolean; onEdit: () => void; onToggle: () => void; onDelete: () => void }) {
  return (
    <div className={`mw-card mw-group ${group.enabled ? '' : 'is-off'}`}>
      <div className="mw-group-head">
        <GroupIcon size={28} />
        <div className="mw-group-title"><strong>{group.name}</strong><span className="mw-mono-text">group/{group.id}</span></div>
        <span className="mw-chip">{STRATEGY_LABEL[group.strategy]}</span>
        <span className="mw-flex" />
        <button type="button" className="mw-icon-btn" aria-label={`编辑 ${group.name}`} onClick={onEdit}><Pencil className="h-3.5 w-3.5" /></button>
        <button type="button" className="mw-icon-btn" aria-label={`删除 ${group.name}`} disabled={busy} onClick={onDelete}><Trash2 className="h-3.5 w-3.5" /></button>
        <button type="button" role="switch" aria-checked={group.enabled} aria-label={`启用 ${group.name}`} disabled={busy} className={`mw-switch ${group.enabled ? 'is-on' : ''}`} onClick={onToggle}><span /></button>
      </div>
      <ol className="mw-members">
        {group.members.map((member, index) => (
          <li key={member}>
            <span className="mw-member-n">{index + 1}</span>
            <div className="mw-member-main"><strong className="mw-mono-text">{member}</strong></div>
            {group.strategy === 'manual' && group.manualMember === member && <span className="mw-chip is-success">固定使用</span>}
            {group.strategy === 'weighted' && <span className="mw-chip">权重 {memberWeight(group, member)} · {weightShare(group, member)}%</span>}
          </li>
        ))}
      </ol>
      {group.rules.length > 0 && (
        <div className={`mw-rules ${group.strategy === 'manual' ? 'is-paused' : ''}`}>
          {group.rules.map((rule, index) => (
            <div key={index} className="mw-rule">
              <span className="mw-rule-when">当 <b>{ruleSummary(rule.condition)}</b></span>
              <span className="mw-rule-arrow">→ 先用</span>
              <span className="mw-rule-use mw-mono-text">{rule.member}</span>
            </div>
          ))}
        </div>
      )}
      <div className="mw-group-foot">
        <span className="mw-foot-item">会话保持 {ttlLabel(group.sessionTtlSecs)}</span>
      </div>
    </div>
  );
}

function LiveRoutingCard() {
  const { scene, loaded } = useRoutingLive({ readExternal: readExternalGateway });
  const live = scene.sources.some((source) => source.reachable);
  return (
    <section className="mw-card rs-card" aria-label="实时路由">
      <div className="mw-panel-head rs-card-head">
        <h3>实时路由</h3>
        <span className={`rs-livedot ${live ? 'is-on' : ''}`} aria-hidden="true" />
        <span className="mw-caption">{live ? '网关怎么分配每个请求，失败时切到哪个成员' : '未连接'}</span>
        <span className="mw-flex" />
        {scene.empty === null && (
          <dl className="rs-stats" aria-label="最近记录统计">
            <div><dt>在途</dt><dd>{scene.stats.inflight}</dd></div>
            <div><dt>已改道</dt><dd>{scene.stats.rerouted}</dd></div>
            <div><dt>失败</dt><dd>{scene.stats.failed}</dd></div>
          </dl>
        )}
      </div>
      {!loaded ? null : scene.empty ? <RoutingStageEmpty scene={scene} /> : <RoutingStage scene={scene} />}
    </section>
  );
}

function DecisionList({ decisions }: { decisions: RouteDecision[] }) {
  if (decisions.length === 0) return <p className="mw-caption">还没有路由决策。Agent 使用 group/… 模型后，这里会显示网关的选择。</p>;
  return (
    <ul>
      {decisions.map((decision) => (
        <li key={`${decision.requestId}-${decision.ts}`}>
          <div className="mw-decision-top">
            <span className="mw-decision-time">{shortTime(decision.ts)}</span>
            <span className="mw-mono-text mw-decision-identity" tabIndex={0} title={`group/${decision.group}`}>group/{decision.group}</span>
            <span className="mw-faint">→</span>
            <strong className="mw-mono-text mw-decision-identity" tabIndex={0} title={decision.chosen ?? undefined}>{decision.chosen ?? '无可用成员'}</strong>
          </div>
          <div className="mw-decision-why">
            <span className="mw-chip">{DECISION_REASON_LABEL[decision.reason] ?? decision.reason}</span>
            {decision.detail !== (DECISION_REASON_LABEL[decision.reason] ?? decision.reason) && <span>{decision.detail}</span>}
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
        </li>
      ))}
    </ul>
  );
}

export function RoutingPage({ onNotify, onConfirm }: PageProps) {
  const [groups, setGroups] = useState<RoutingGroup[] | null>(null);
  const [providers, setProviders] = useState<ProviderView[]>([]);
  const [decisions, setDecisions] = useState<RouteDecision[]>([]);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<{ group: RoutingGroup; isNew: boolean } | null>(null);

  const load = useCallback(async () => {
    try {
      const [nextGroups, nextProviders, nextDecisions] = await Promise.all([listRoutingGroups(), listProviders(), recentRouteDecisions(30)]);
      setGroups(nextGroups);
      setProviders(nextProviders);
      setDecisions(nextDecisions);
      setLoadError('');
    } catch (error) {
      setLoadError(errorText(error));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const options = useMemo(() => modelOptions(providers, []), [providers]);

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
    const confirmed = await onConfirm({ title: `删除路由组 ${group.name}？`, description: `仍在使用 group/${group.id} 的 Agent 请求会失败，需要改选模型。`, confirmLabel: '删除', tone: 'danger' });
    if (!confirmed) return;
    setBusy(true);
    try {
      setGroups(await deleteRoutingGroup(group.id));
      onNotify('success', `${group.name} 已删除`);
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
            {groups?.length ?? 0} 个路由组
            <InfoTip label="路由组说明">
              <span>在 Agent 与网关模型目录里显示为 group/…。</span>
              <span>失败时：还没回复才换下一个成员，流式开始后不再切换。</span>
            </InfoTip>
          </span>
          <button type="button" className="mw-btn is-primary" disabled={options.length === 0} title={options.length === 0 ? '先在供应商页启用供应商并列出模型' : undefined} onClick={createNew}><Plus className="h-4 w-4" />新建路由组</button>
        </div>
        {loadError && <p className="mw-note is-danger" role="alert">读取路由组失败：{loadError}</p>}
        {groups && groups.length === 0 && <div className="mw-card mw-empty"><p>还没有路由组。把多个供应商的模型合成一个虚拟模型，失败自动切换，也能按图片、上下文长度等规则选择。</p></div>}
        {groups?.map((group) => (
          <GroupCard
            key={group.id}
            group={group}
            busy={busy}
            onEdit={() => setEditing({ group, isNew: false })}
            onToggle={() => void save({ ...group, enabled: !group.enabled }, group.enabled ? `${group.name} 已停用` : `${group.name} 已启用`)}
            onDelete={() => void remove(group)}
          />
        ))}
      </div>
      <aside className="mw-card mw-decisions" aria-label="最近路由决策">
        <div className="mw-panel-head"><h3>最近决策</h3><button type="button" className="mw-btn is-ghost" onClick={() => void load()}>刷新</button></div>
        <DecisionList decisions={decisions} />
      </aside>
      {editing && (
        <Sheet title={editing.isNew ? '新建路由组' : editing.group.name} subtitle={editing.isNew ? '多个供应商的模型合成一个虚拟模型' : `group/${editing.group.id}`} icon={<GroupIcon size={36} />} onClose={() => setEditing(null)}>
          <GroupEditor
            key={editing.group.id}
            initial={editing.group}
            isNew={editing.isNew}
            options={options}
            busy={busy}
            onSave={(group) => void save(group, editing.isNew ? `${group.name} 已创建` : `${group.name} 已保存`).then((ok) => { if (ok) setEditing(null); })}
          />
        </Sheet>
      )}
    </div>
  );
}

export default RoutingPage;
