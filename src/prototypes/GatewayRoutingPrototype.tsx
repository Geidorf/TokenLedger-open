import { useState } from 'react';
import { Brain, Check, ChevronDown, Clock3, Copy, GripVertical, Image as ImageIcon, Layers, Minimize2, Plus, RotateCcw, Search, Sparkles, Trash2, UserRound } from 'lucide-react';
import { BrandIcon, GroupIcon, Seg } from './prototypeKit';
import {
  AFFINITY_LABEL,
  DECISION_LABEL,
  GATEWAY_CATALOG,
  ROUTING_DECISIONS,
  ROUTING_GROUPS,
  ROUTING_MODE_HINT,
  ROUTING_MODE_LABEL,
  type GroupRule,
  type RoutingGroup,
  type RoutingMode,
} from './modelWorkspaceFixtures';

type ApiTab = 'responses' | 'chat' | 'anthropic';
type CodeTab = 'curl' | 'python' | 'node';

const BASE = 'http://127.0.0.1:3462';

function CopyField({ label, value, mono = true }: { label: string; value: string; mono?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mw-copy-field">
      <span className="mw-copy-label">{label}</span>
      <span className={`mw-copy-value ${mono ? 'is-mono' : ''}`}>{value}</span>
      <button type="button" className="mw-icon-btn" aria-label={`复制${label}`} onClick={() => { setCopied(true); window.setTimeout(() => setCopied(false), 1200); }}>
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
    </div>
  );
}

function sample(api: ApiTab, code: CodeTab, model: string) {
  const path = api === 'chat' ? '/v1/chat/completions' : api === 'responses' ? '/v1/responses' : '/v1/messages';
  const body = api === 'chat' ? `{"model":"${model}","messages":[{"role":"user","content":"你好"}]}` : api === 'responses' ? `{"model":"${model}","input":"你好"}` : `{"model":"${model}","max_tokens":256,"messages":[{"role":"user","content":"你好"}]}`;
  if (code === 'curl') return `curl ${BASE}${path} \\\n  -H "Authorization: Bearer $TOKENLEDGER_TOKEN" \\\n  -H "Content-Type: application/json" \\\n  -d '${body}'`;
  if (code === 'python') {
    return api === 'anthropic'
      ? `from anthropic import Anthropic\nclient = Anthropic(base_url="${BASE}", api_key=TOKEN)\nclient.messages.create(model="${model}", max_tokens=256,\n    messages=[{"role": "user", "content": "你好"}])`
      : `from openai import OpenAI\nclient = OpenAI(base_url="${BASE}/v1", api_key=TOKEN)\n${api === 'chat' ? `client.chat.completions.create(model="${model}",\n    messages=[{"role": "user", "content": "你好"}])` : `client.responses.create(model="${model}", input="你好")`}`;
  }
  return api === 'anthropic'
    ? `import Anthropic from '@anthropic-ai/sdk';\nconst client = new Anthropic({ baseURL: '${BASE}', apiKey: TOKEN });\nawait client.messages.create({ model: '${model}', max_tokens: 256,\n  messages: [{ role: 'user', content: '你好' }] });`
    : `import OpenAI from 'openai';\nconst client = new OpenAI({ baseURL: '${BASE}/v1', apiKey: TOKEN });\n${api === 'chat' ? `await client.chat.completions.create({ model: '${model}',\n  messages: [{ role: 'user', content: '你好' }] });` : `await client.responses.create({ model: '${model}', input: '你好' });`}`;
}

export function GatewayView({ onOpenRecords, onOpenRouting }: { onOpenRecords: () => void; onOpenRouting: () => void }) {
  const [api, setApi] = useState<ApiTab>('responses');
  const [code, setCode] = useState<CodeTab>('curl');
  const [query, setQuery] = useState('');
  const model = 'group/coding';
  const q = query.trim().toLowerCase();
  const catalog = GATEWAY_CATALOG.filter((item) => `${item.id} ${item.name} ${item.via}`.toLowerCase().includes(q));
  return (
    <div className="mw-page-stack">
      <div className="mw-card mw-status-bar">
        <span className="mw-led" />
        <strong>运行中</strong>
        <span className="mw-faint">·</span>
        <span>{GATEWAY_CATALOG.length} 个模型（含 2 个路由组）</span>
        <span className="mw-faint">·</span>
        <span className="mw-mono-text">{BASE}</span>
        <span className="mw-flex" />
        <span className="mw-caption">今日 498 次请求 · 3 次自动切换</span>
        <button type="button" className="mw-btn is-ghost" onClick={onOpenRecords}>查看请求记录</button>
        <button type="button" className="mw-btn is-ghost"><RotateCcw className="h-3.5 w-3.5" />重启</button>
      </div>

      <div className="mw-card mw-panel">
        <div className="mw-panel-head">
          <h3>接入</h3>
          <span>已接入的 Agent 会自动写好下面这些；其他客户端（脚本、IDE 插件）照着填即可</span>
        </div>
        <div className="mw-connect">
          <Seg value={api} options={[{ id: 'responses', label: 'OpenAI Responses' }, { id: 'chat', label: 'OpenAI Chat' }, { id: 'anthropic', label: 'Anthropic（即将支持）' }]} onChange={setApi} label="接入协议" size="sm" />
          <div className="mw-connect-fields">
            <CopyField label="Base URL" value={api === 'anthropic' ? BASE : `${BASE}/v1`} />
            <CopyField label="API 密钥" value="tl-local-••••••••9e1a" />
            <CopyField label="模型" value={model} />
          </div>
          <div className="mw-code">
            <div className="mw-code-head">
              <Seg value={code} options={[{ id: 'curl', label: 'curl' }, { id: 'python', label: 'Python' }, { id: 'node', label: 'Node' }]} onChange={setCode} label="示例语言" size="sm" />
              <button type="button" className="mw-btn is-ghost"><Copy className="h-3.5 w-3.5" />复制</button>
            </div>
            <pre>{sample(api, code, model)}</pre>
          </div>
          <p className="mw-caption">密钥只在本机有效，网关只监听 127.0.0.1；供应商 key 存在系统钥匙串里，不会出现在任何客户端配置中。</p>
        </div>
      </div>

      <div className="mw-card mw-panel">
        <div className="mw-panel-head">
          <h3>模型目录</h3>
          <div className="mw-panel-tools">
            <label className="mw-search is-inline"><Search className="h-4 w-4" aria-hidden="true" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索模型" aria-label="搜索模型目录" /></label>
            <button type="button" className="mw-btn is-ghost"><Copy className="h-3.5 w-3.5" />复制全部 ID</button>
          </div>
        </div>
        <ul className="mw-catalog">
          {catalog.map((item) => (
            <li key={item.id}>
              {item.isGroup ? <GroupIcon size={22} /> : <BrandIcon id={item.icon} fallback="Q1" size={22} />}
              <div className="mw-catalog-main">
                <span className="mw-mono-text">{item.id}</span>
                <small>{item.name} · {item.via}</small>
              </div>
              <div className="mw-badges">
                {item.isGroup && <button type="button" className="mw-chip is-info" onClick={onOpenRouting}>路由组</button>}
                {item.reasoning && <span className="mw-chip" title="支持推理"><Brain className="h-3 w-3" />推理</span>}
                {item.images && <span className="mw-chip" title="支持图片"><ImageIcon className="h-3 w-3" />图片</span>}
                <span className="mw-chip">{item.context}</span>
              </div>
              <button type="button" className="mw-icon-btn" aria-label={`复制 ${item.id}`}><Copy className="h-3.5 w-3.5" /></button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

const RULE_ICON: Record<GroupRule['kind'], typeof ImageIcon> = { images: ImageIcon, tokens: Layers, compact: Minimize2, agent: UserRound, time: Clock3, effort: Brain };

function GroupCard({ group, onMode }: { group: RoutingGroup; onMode: (mode: RoutingMode) => void }) {
  const [members, setMembers] = useState(group.members);
  const [pick, setPick] = useState(group.members[0]?.ref);
  const labelOf = (ref: string) => members.find((member) => member.ref === ref)?.label ?? ref;
  const iconOf = (ref: string) => members.find((member) => member.ref === ref)?.icon ?? null;
  if (group.auto) {
    return (
      <div className="mw-card mw-group is-auto">
        <div className="mw-group-head">
          <GroupIcon size={28} />
          <div className="mw-group-title"><strong>{group.name}</strong><span className="mw-mono-text">group/{group.id}</span></div>
          <span className="mw-chip"><Sparkles className="h-3 w-3" />自动发现</span>
          <span className="mw-flex" />
          <button type="button" className="mw-btn is-ghost">改成我的路由组</button>
        </div>
        <p className="mw-caption">同名模型由 {members.length} 个供应商提供，自动合并为一组，按「智能」分配：{members.map((member) => member.label).join('、')}。</p>
      </div>
    );
  }
  return (
    <div className="mw-card mw-group">
      <div className="mw-group-head">
        <GroupIcon size={28} />
        <div className="mw-group-title"><strong>{group.name}</strong><span className="mw-mono-text">group/{group.id}</span></div>
        {group.usedBy.length > 0 && <span className="mw-chip is-success">{group.usedBy.join('、')} 在用</span>}
        <span className="mw-flex" />
        <span className="mw-caption">今日 {group.requestsToday} 次 · 切换 {group.failoversToday} 次</span>
      </div>
      <div className="mw-group-mode">
        <Seg value={group.mode} options={(Object.keys(ROUTING_MODE_LABEL) as RoutingMode[]).map((id) => ({ id, label: ROUTING_MODE_LABEL[id] }))} onChange={onMode} label="分配方式" size="sm" />
        <span className="mw-caption">{ROUTING_MODE_HINT[group.mode]}</span>
      </div>
      <ol className="mw-members">
        {members.map((member, index) => (
          <li key={member.ref} className={!member.on ? 'is-off' : ''}>
            <GripVertical className="mw-grip" aria-hidden="true" />
            <span className="mw-member-n">{index + 1}</span>
            <BrandIcon id={member.icon} fallback="Q1" size={20} />
            <div className="mw-member-main">
              <strong>{member.label}</strong>
              <small className="mw-mono-text">{member.ref}</small>
            </div>
            {member.state === 'ready' && member.on && <span className="mw-chip is-success">就绪</span>}
            {member.state === 'resting' && <span className="mw-chip is-warning">{member.stateText}</span>}
            {member.state === 'auth' && <span className="mw-chip is-danger">{member.stateText}</span>}
            <span className="mw-member-share" title="今日分到的请求">
              <span className="mw-share-track"><span style={{ width: `${member.share * 100}%` }} /></span>
              {Math.round(member.share * 100)}%
            </span>
            {group.mode === 'manual'
              ? <button type="button" role="radio" aria-checked={pick === member.ref} className={`mw-radio ${pick === member.ref ? 'is-on' : ''}`} aria-label={`只用 ${member.label}`} onClick={() => setPick(member.ref)}><span /></button>
              : <button type="button" role="switch" aria-checked={member.on} aria-label={`启用 ${member.label}`} className={`mw-switch ${member.on ? 'is-on' : ''}`} onClick={() => setMembers((list) => list.map((item) => (item.ref === member.ref ? { ...item, on: !item.on } : item)))}><span /></button>}
          </li>
        ))}
        <li className="mw-members-add"><button type="button" className="mw-link-btn"><Plus className="h-3.5 w-3.5" />添加成员</button></li>
      </ol>
      <div className={`mw-rules ${group.mode === 'manual' ? 'is-paused' : ''}`}>
        <div className="mw-panel-head is-sub">
          <h3>规则</h3>
          <span>{group.mode === 'manual' ? '手动模式下规则暂停' : '一轮对话开始时判断，整轮不换模型；第一条命中的生效，其余成员留作后备'}</span>
        </div>
        {group.rules.length === 0 && <p className="mw-caption">没有规则：所有请求按上面的分配方式走。</p>}
        {group.rules.map((rule) => {
          const Icon = RULE_ICON[rule.kind];
          return (
            <div key={rule.id} className="mw-rule">
              <GripVertical className="mw-grip" aria-hidden="true" />
              <Icon className="mw-rule-icon" aria-hidden="true" />
              <span className="mw-rule-when">当 <b>{rule.when}</b></span>
              <span className="mw-rule-arrow">→ 先用</span>
              <span className="mw-rule-use"><BrandIcon id={iconOf(rule.use)} fallback="?" size={16} />{labelOf(rule.use)}</span>
              <span className="mw-flex" />
              <button type="button" className="mw-icon-btn" aria-label="删除规则"><Trash2 className="h-3.5 w-3.5" /></button>
            </div>
          );
        })}
        <button type="button" className="mw-link-btn"><Plus className="h-3.5 w-3.5" />添加规则 <span className="mw-faint">带图片 · 上下文长度 · 推理强度 · Agent · 时段 · 压缩对话</span></button>
      </div>
      <div className="mw-group-foot">
        <span className="mw-foot-item">会话保持 <button type="button" className="mw-select">{AFFINITY_LABEL[group.affinity]}<ChevronDown className="h-3.5 w-3.5" /></button></span>
        <span className="mw-caption">失败时：还没回复才换下一个成员，Agent 只会收到一份完整回复</span>
      </div>
    </div>
  );
}

export function RoutingView() {
  const [groups, setGroups] = useState(ROUTING_GROUPS);
  return (
    <div className="mw-routing">
      <div className="mw-routing-main">
        <div className="mw-toolbar">
          <span className="mw-caption">{groups.filter((group) => !group.auto).length} 个路由组 · {groups.filter((group) => group.auto).length} 个自动发现 · 路由组在网关模型目录里显示为 group/…</span>
          <button type="button" className="mw-btn is-primary"><Plus className="h-4 w-4" />新建路由组</button>
        </div>
        {groups.map((group) => (
          <GroupCard key={group.id} group={group} onMode={(mode) => setGroups((list) => list.map((item) => (item.id === group.id ? { ...item, mode } : item)))} />
        ))}
      </div>
      <aside className="mw-card mw-decisions" aria-label="实时决策">
        <div className="mw-panel-head"><h3><span className="mw-led" />实时决策</h3><span>网关刚做的选择</span></div>
        <ul>
          {ROUTING_DECISIONS.map((decision) => (
            <li key={`${decision.time}-${decision.reason}`}>
              <div className="mw-decision-top">
                <span className="mw-decision-time">{decision.time}</span>
                <BrandIcon id={decision.agentIcon} size={14} />
                <span className="mw-mono-text">{decision.group}</span>
                <span className="mw-faint">→</span>
                <BrandIcon id={decision.toIcon} size={14} />
                <strong>{decision.to}</strong>
              </div>
              <div className="mw-decision-why">
                <span className={`mw-chip is-${decision.kind}`}>{DECISION_LABEL[decision.kind]}</span>
                <span>{decision.reason}</span>
              </div>
            </li>
          ))}
        </ul>
      </aside>
    </div>
  );
}
