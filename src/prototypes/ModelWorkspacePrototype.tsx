import { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  BarChart3,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  FileDiff,
  History,
  KeyRound,
  LoaderCircle,
  Plus,
  RefreshCw,
  Route,
  Search,
  Server,
  Settings,
  ShieldCheck,
  Undo2,
  X,
} from 'lucide-react';
import { TokenLedgerIcon } from '../components/brand/TokenLedgerIcon';
import {
  AGENTS,
  PRESET_GROUPS,
  PROVIDERS,
  ROUTING_GROUPS,
  WIRE_LABEL,
  type Effort,
  type PresetGroup,
  type PrototypeAgent,
  type PrototypeProvider,
} from './modelWorkspaceFixtures';
import { BrandIcon, GroupIcon } from './prototypeKit';
import { UsageView, type UsageSub } from './UsagePrototype';
import { GatewayView, RoutingView } from './GatewayRoutingPrototype';
import './model-workspace-prototype.css';

type Page = 'usage' | 'agents' | 'providers' | 'gateway' | 'routing';
type Preset = PresetGroup['presets'][number];
type AddStep = 'pick' | 'form' | 'running' | 'done';

const PAGES: Record<Page, { title: string; subtitle: string }> = {
  usage: { title: '用量', subtitle: '本机扫描与网关记录合并后的 Token 与费用。有效 Token = 输入 + 输出，缓存单列。' },
  agents: { title: 'Agent', subtitle: '给每个本机 Agent 选模型或路由组。请求经本机网关转发并记账。' },
  providers: { title: '供应商', subtitle: '添加 API key，模型就出现在 Agent 和路由组的选择器里。' },
  gateway: { title: '网关', subtitle: '本机 127.0.0.1 上的统一入口：协议转换、记账、路由。' },
  routing: { title: '路由', subtitle: '把多个供应商的模型合成一个虚拟模型，按规则选择、失败自动切换。' },
};
const EFFORT_LABEL: Record<Effort, string> = { low: '低', medium: '中', high: '高' };

const params = () => new URLSearchParams(window.location.search);
const initialPage = (): Page => {
  const page = params().get('page') ?? params().get('tab');
  return page === 'agents' || page === 'providers' || page === 'gateway' || page === 'routing' ? page : 'usage';
};
const initialSub = (): UsageSub => {
  const sub = params().get('sub');
  return sub === 'records' || sub === 'sessions' ? sub : 'overview';
};

function PrototypeSidebar({ page, onPage }: { page: Page; onPage: (page: Page) => void }) {
  const primary: { id: Page | 'logs' | 'settings'; label: string; icon: typeof BarChart3 }[] = [
    { id: 'usage', label: '用量', icon: BarChart3 },
    { id: 'logs', label: '活动明细', icon: History },
  ];
  const models: { id: Page; label: string; icon: typeof BarChart3 }[] = [
    { id: 'agents', label: 'Agent', icon: Bot },
    { id: 'providers', label: '供应商', icon: Server },
    { id: 'gateway', label: '网关', icon: Activity },
    { id: 'routing', label: '路由', icon: Route },
  ];
  const item = (entry: { id: string; label: string; icon: typeof BarChart3 }) => {
    const active = entry.id === page;
    const navigable = entry.id !== 'logs' && entry.id !== 'settings';
    return (
      <button key={entry.id} type="button" className={`nav-item ${active ? 'nav-item-active mw-nav-active' : ''}`} aria-current={active ? 'page' : undefined} onClick={() => navigable && onPage(entry.id as Page)}>
        <entry.icon className="h-4 w-4" />
        <span>{entry.label}</span>
      </button>
    );
  };
  return (
    <aside className="app-sidebar">
      <div className="sidebar-surface">
        <div className="sidebar-top">
          <div className="sidebar-brand">
            <div className="sidebar-logo"><TokenLedgerIcon className="sidebar-logo-mark" /></div>
            <div className="min-w-0">
              <div className="sidebar-title truncate">TokenLedger</div>
              <div className="sidebar-subtitle truncate">个人 AI 用量账本</div>
            </div>
          </div>
          <nav className="sidebar-nav sidebar-nav-primary" aria-label="主要页面导航">
            {primary.map(item)}
            <div className="mw-nav-section">模型接入</div>
            {models.map(item)}
            <div className="mw-nav-section" />
            {item({ id: 'settings', label: '设置与云端', icon: Settings })}
          </nav>
        </div>
        <div className="sidebar-actions">
          <div className="sidebar-footer-version"><span>TokenLedger 原型 · 假数据</span></div>
        </div>
      </div>
    </aside>
  );
}

function StatusDot({ provider }: { provider: PrototypeProvider }) {
  const best = provider.apis.filter((api) => api.ok && api.latencyMs !== null).sort((a, b) => (a.latencyMs ?? 0) - (b.latencyMs ?? 0))[0];
  if (provider.health === 'auth') return <span className="mw-status is-danger"><i />认证失败</span>;
  if (provider.health === 'untested') return <span className="mw-status"><i />未测试</span>;
  if (provider.health === 'proxied') return <span className="mw-status is-warning"><i />经本机代理 · {best?.latencyMs} ms</span>;
  return <span className="mw-status is-success"><i />{best?.latencyMs} ms</span>;
}

function ProviderRow({ provider, onOpen, onToggle }: { provider: PrototypeProvider; onOpen: () => void; onToggle: () => void }) {
  const exposed = provider.models.filter((model) => model.exposed).length;
  return (
    <div className={`mw-row ${provider.health === 'auth' && provider.enabled ? 'is-danger' : ''} ${provider.enabled ? '' : 'is-off'}`}>
      <button type="button" className="mw-row-main" onClick={onOpen}>
        <BrandIcon id={provider.icon} fallback={provider.monogram} size={28} />
        <span className="mw-row-title">
          <strong>{provider.name}</strong>
          <small>{provider.host} · {exposed} 个模型{provider.usedBy.length > 0 ? ` · ${provider.usedBy.join('、')} 在用` : ''}</small>
        </span>
        <span className="mw-row-meta">
          {provider.enabled && <StatusDot provider={provider} />}
          <span className="mw-mono-text mw-faint">{provider.keyHint ?? '无需 key'}</span>
        </span>
      </button>
      {provider.health === 'auth' && provider.enabled && <button type="button" className="mw-btn is-danger-ghost" onClick={onOpen}>更换 key</button>}
      <button type="button" role="switch" aria-checked={provider.enabled} aria-label={`启用 ${provider.name}`} className={`mw-switch ${provider.enabled ? 'is-on' : ''}`} onClick={onToggle}><span /></button>
      <ChevronRight className="mw-row-arrow" aria-hidden="true" />
    </div>
  );
}

function ProvidersView({ providers, onOpen, onToggle, onAdd }: { providers: PrototypeProvider[]; onOpen: (id: string) => void; onToggle: (id: string) => void; onAdd: () => void }) {
  const [showOff, setShowOff] = useState(false);
  const on = providers.filter((provider) => provider.enabled);
  const off = providers.filter((provider) => !provider.enabled);
  const broken = on.filter((provider) => provider.health === 'auth').length;
  return (
    <>
      <div className="mw-toolbar">
        <span className="mw-caption">{on.length} 个启用{broken > 0 ? ` · ${broken} 个需要处理` : ''} · key 存在系统钥匙串，只由网关读取</span>
        <button type="button" className="mw-btn is-primary" onClick={onAdd}><Plus className="h-4 w-4" />添加供应商</button>
      </div>
      <div className="mw-card mw-rows">
        {on.map((provider) => <ProviderRow key={provider.id} provider={provider} onOpen={() => onOpen(provider.id)} onToggle={() => onToggle(provider.id)} />)}
      </div>
      {off.length > 0 && (
        <>
          <button type="button" className="mw-collapse" aria-expanded={showOff} onClick={() => setShowOff((value) => !value)}>
            <ChevronDown className={`h-4 w-4 ${showOff ? '' : 'is-closed'}`} />已停用的供应商（{off.length}）
          </button>
          {showOff && <div className="mw-card mw-rows">{off.map((provider) => <ProviderRow key={provider.id} provider={provider} onOpen={() => onOpen(provider.id)} onToggle={() => onToggle(provider.id)} />)}</div>}
        </>
      )}
    </>
  );
}

function targetOf(agent: PrototypeAgent, providers: PrototypeProvider[]) {
  if (agent.groupId) {
    const group = ROUTING_GROUPS.find((item) => item.id === agent.groupId);
    return { icon: <GroupIcon size={18} />, label: group?.name ?? agent.groupId, sub: `group/${agent.groupId}` };
  }
  const provider = providers.find((item) => item.id === agent.providerId);
  const model = provider?.models.find((item) => item.id === agent.modelId);
  return { icon: <BrandIcon id={provider?.icon} fallback={provider?.monogram} size={18} />, label: model?.name ?? '未选择', sub: provider?.name ?? '' };
}

function ModelPicker({ agent, providers, onPick, onPickGroup, onClose }: {
  agent: PrototypeAgent;
  providers: PrototypeProvider[];
  onPick: (providerId: string, modelId: string) => void;
  onPickGroup: (groupId: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const q = query.trim().toLowerCase();
  const groups = ROUTING_GROUPS.filter((group) => !group.auto && `${group.name} ${group.id}`.toLowerCase().includes(q));
  return (
    <div className="mw-popover" role="dialog" aria-label={`为 ${agent.name} 选择模型`}>
      <label className="mw-search is-compact">
        <Search className="h-4 w-4" aria-hidden="true" />
        <input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索模型或路由组" aria-label="搜索模型" />
      </label>
      <div className="mw-popover-body tl-scrollbar">
        {groups.length > 0 && (
          <section>
            <h4><GroupIcon size={16} />路由组</h4>
            {groups.map((group) => (
              <button key={group.id} type="button" className={`mw-pick ${agent.groupId === group.id ? 'is-current' : ''}`} onClick={() => onPickGroup(group.id)}>
                <span><strong>{group.name}</strong><small>group/{group.id} · {group.members.filter((member) => member.on).length} 个成员</small></span>
                {agent.groupId === group.id && <Check className="h-4 w-4" />}
              </button>
            ))}
          </section>
        )}
        {providers.filter((provider) => provider.enabled).map((provider) => {
          const models = provider.models.filter((model) => model.exposed && `${model.name} ${model.id}`.toLowerCase().includes(q));
          if (models.length === 0) return null;
          const unavailable = provider.health === 'auth';
          return (
            <section key={provider.id}>
              <h4><BrandIcon id={provider.icon} fallback={provider.monogram} size={16} />{provider.name}{unavailable && <span className="mw-chip is-danger">认证失败</span>}</h4>
              {models.map((model) => {
                const current = !agent.groupId && agent.providerId === provider.id && agent.modelId === model.id;
                return (
                  <button key={model.id} type="button" disabled={unavailable} className={`mw-pick ${current ? 'is-current' : ''}`} onClick={() => onPick(provider.id, model.id)}>
                    <span><strong>{model.name}</strong><small>{model.context}{model.reasoning ? ' · 推理' : ''}</small></span>
                    {current && <Check className="h-4 w-4" />}
                  </button>
                );
              })}
            </section>
          );
        })}
      </div>
      <footer className="mw-popover-foot">只列出已启用的模型 · 在供应商页管理</footer>
    </div>
  );
}

function AgentRow({ agent, providers, pickerOpen, onTogglePicker, onPick, onPickGroup, onEffort, onShowDiff }: {
  agent: PrototypeAgent;
  providers: PrototypeProvider[];
  pickerOpen: boolean;
  onTogglePicker: () => void;
  onPick: (providerId: string, modelId: string) => void;
  onPickGroup: (groupId: string) => void;
  onEffort: (effort: Effort) => void;
  onShowDiff: () => void;
}) {
  const target = targetOf(agent, providers);
  const modelCount = providers.filter((provider) => provider.enabled && provider.health !== 'auth').reduce((sum, provider) => sum + provider.models.filter((model) => model.exposed).length, 0) + ROUTING_GROUPS.filter((group) => !group.auto).length;
  return (
    <div className={`mw-row mw-agent ${agent.supported ? '' : 'is-off'}`}>
      <BrandIcon id={agent.icon} size={30} />
      <span className="mw-row-title">
        <strong>{agent.name} <small className="mw-version">{agent.version}</small></strong>
        <small className="mw-mono-text">{agent.configPath}</small>
      </span>
      {agent.supported ? (
        <>
          <span className="mw-agent-count">{modelCount} 个可选</span>
          <div className="mw-field-col">
            <button type="button" className={`mw-value-btn ${pickerOpen ? 'is-open' : ''}`} aria-expanded={pickerOpen} onClick={onTogglePicker}>
              {target.icon}
              <span><strong>{target.label}</strong><small>{target.sub}</small></span>
              <ChevronDown className="h-3.5 w-3.5" />
            </button>
            {pickerOpen && <ModelPicker agent={agent} providers={providers} onPick={onPick} onPickGroup={onPickGroup} onClose={onTogglePicker} />}
          </div>
          <label className="mw-select is-native">
            <span className="mw-faint">推理</span>
            <select value={agent.effort ?? 'medium'} onChange={(event) => onEffort(event.target.value as Effort)} aria-label={`${agent.name} 推理强度`}>
              {(Object.keys(EFFORT_LABEL) as Effort[]).map((value) => <option key={value} value={value}>{EFFORT_LABEL[value]}</option>)}
            </select>
            <ChevronDown className="h-3.5 w-3.5" />
          </label>
          <button type="button" className="mw-icon-btn" aria-label={`查看 ${agent.name} 配置改动`} title="查看配置改动" onClick={onShowDiff}><FileDiff className="h-4 w-4" /></button>
        </>
      ) : (
        <span className="mw-agent-soon"><span className="mw-chip">已安装 · 即将支持</span><small>{agent.note}</small></span>
      )}
    </div>
  );
}

function ProviderDetail({ provider, onClose, onToggleModel }: { provider: PrototypeProvider; onClose: () => void; onToggleModel: (modelId: string) => void }) {
  return (
    <div className="mw-sheet-layer" role="presentation" onClick={onClose}>
      <aside className="mw-sheet" role="dialog" aria-label={`${provider.name} 详情`} onClick={(event) => event.stopPropagation()}>
        <header className="mw-sheet-head">
          <BrandIcon id={provider.icon} fallback={provider.monogram} size={36} />
          <div className="mw-card-title"><strong>{provider.name}</strong><span>{provider.host}</span></div>
          <button type="button" className="mw-icon-btn" aria-label="关闭" onClick={onClose}><X className="h-4 w-4" /></button>
        </header>
        {provider.note && <p className={`mw-note ${provider.health === 'auth' ? 'is-danger' : provider.health === 'proxied' ? 'is-warning' : ''}`}>{provider.note}</p>}
        <section className="mw-sheet-section">
          <div className="mw-section-row"><h3>连接测试</h3><button type="button" className="mw-btn is-ghost"><RefreshCw className="h-3.5 w-3.5" />重新测试</button></div>
          <ul className="mw-api-list">
            {provider.apis.map((api) => (
              <li key={api.api}>
                <span>{WIRE_LABEL[api.api]}</span>
                {api.ok ? <span className="mw-chip is-success">{api.latencyMs} ms</span> : <span className={`mw-chip ${provider.health === 'auth' ? 'is-danger' : ''}`}>{provider.health === 'auth' ? '401' : '未测试'}</span>}
              </li>
            ))}
          </ul>
        </section>
        <section className="mw-sheet-section">
          <div className="mw-section-row"><h3>API key</h3></div>
          <div className="mw-key-row">
            <KeyRound className="h-4 w-4" aria-hidden="true" />
            <span>{provider.keyHint ?? '本地服务无需 key'}</span>
            {provider.keyHint && <button type="button" className="mw-btn is-ghost">更换</button>}
          </div>
          <p className="mw-caption">key 保存在系统钥匙串，只由 TokenLedger 网关读取；Agent 配置里不会出现。</p>
        </section>
        <section className="mw-sheet-section">
          <div className="mw-section-row"><h3>模型</h3><span className="mw-caption">关掉的模型不会出现在 Agent 的选择器里</span></div>
          <ul className="mw-model-list">
            {provider.models.map((model) => (
              <li key={model.id}>
                <div><strong>{model.name}</strong><span>{model.id} · 上下文 {model.context}{model.reasoning ? ' · 推理' : ''}</span></div>
                <button type="button" role="switch" aria-checked={model.exposed} aria-label={`启用 ${model.name}`} className={`mw-switch ${model.exposed ? 'is-on' : ''}`} onClick={() => onToggleModel(model.id)}><span /></button>
              </li>
            ))}
          </ul>
        </section>
        <footer className="mw-sheet-foot"><button type="button" className="mw-btn is-danger-ghost">删除供应商</button></footer>
      </aside>
    </div>
  );
}


function AddProviderSheet({ onClose, onAdded, initialPreset }: { onClose: () => void; onAdded: (preset: Preset) => void; initialPreset: Preset | null }) {
  const [query, setQuery] = useState('');
  const [preset, setPreset] = useState<Preset | null>(initialPreset);
  const [step, setStep] = useState<AddStep>(() => {
    if (!initialPreset) return 'pick';
    return params().get('step') === 'done' ? 'done' : 'form';
  });
  const [stage, setStage] = useState(() => (step === 'done' ? 3 : 0));
  const groups = useMemo(() => PRESET_GROUPS.map((group) => ({
    ...group,
    presets: group.presets.filter((item) => `${item.name} ${item.host}`.toLowerCase().includes(query.trim().toLowerCase())),
  })).filter((group) => group.presets.length > 0), [query]);

  useEffect(() => {
    if (step !== 'running') return;
    if (stage >= 3) { setStep('done'); return; }
    const timer = window.setTimeout(() => setStage((value) => value + 1), 650);
    return () => window.clearTimeout(timer);
  }, [stage, step]);

  const stages = ['保存 key 到钥匙串', '拉取模型列表', '发送一次最小请求'];
  return (
    <div className="mw-sheet-layer" role="presentation" onClick={onClose}>
      <aside className="mw-sheet mw-add-sheet" role="dialog" aria-label="添加供应商" onClick={(event) => event.stopPropagation()}>
        <header className="mw-sheet-head">
          {step !== 'pick' && preset ? <BrandIcon id={preset.icon} fallback={preset.monogram} size={36} /> : <span className="mw-head-icon"><Plus className="h-4 w-4" /></span>}
          <div className="mw-card-title"><strong>{step === 'pick' || !preset ? '添加供应商' : preset.name}</strong><span>{step === 'pick' || !preset ? '选一个预设，贴上 key 就能用' : preset.host}</span></div>
          <button type="button" className="mw-icon-btn" aria-label="关闭" onClick={onClose}><X className="h-4 w-4" /></button>
        </header>

        {step === 'pick' && (
          <>
            <label className="mw-search">
              <Search className="h-4 w-4" aria-hidden="true" />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索供应商或接口地址" aria-label="搜索供应商" />
            </label>
            <div className="mw-preset-groups">
              {groups.map((group) => (
                <section key={group.id}>
                  <h3>{group.label}</h3>
                  <div className="mw-preset-grid">
                    {group.presets.map((item) => (
                      <button key={item.id} type="button" className="mw-preset" onClick={() => { setPreset(item); setStep('form'); }}>
                        <BrandIcon id={item.icon} fallback={item.monogram} size={22} />
                        <span><strong>{item.name}</strong><small>{item.keyless ? '本地 · 无需 key' : item.host}</small></span>
                      </button>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          </>
        )}

        {step === 'form' && preset && (
          <form className="mw-add-form" onSubmit={(event) => { event.preventDefault(); setStage(0); setStep('running'); }}>
            {preset.custom && (
              <>
                <label className="mw-field"><span>名称</span><input defaultValue="" placeholder="例如：公司中转" /></label>
                <label className="mw-field"><span>接口地址</span><input defaultValue="" placeholder="https://relay.example.com/v1" /><small>协议会自动探测，不用手选</small></label>
              </>
            )}
            {!preset.keyless && (
              <label className="mw-field"><span>API key</span><input type="password" autoComplete="off" placeholder="sk-…" /><small>保存在系统钥匙串，只由 TokenLedger 网关读取</small></label>
            )}
            {preset.keyless && <p className="mw-note">本地服务无需 key，保存后会直接探测 {preset.host}。</p>}
            <div className="mw-form-actions">
              {!initialPreset && <button type="button" className="mw-btn is-ghost" onClick={() => setStep('pick')}>返回</button>}
              <button type="submit" className="mw-btn is-primary">保存并测试</button>
            </div>
          </form>
        )}

        {(step === 'running' || step === 'done') && preset && (
          <div className="mw-progress">
            <ol>
              {stages.map((label, index) => (
                <li key={label} className={index < stage ? 'is-done' : index === stage && step === 'running' ? 'is-active' : ''}>
                  {index < stage ? <Check className="h-4 w-4" /> : index === stage && step === 'running' ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <span className="mw-dot" />}
                  <span>{label}</span>
                  {index === 1 && index < stage && <small>找到 24 个模型</small>}
                  {index === 2 && index < stage && <small>Responses 412 ms</small>}
                </li>
              ))}
            </ol>
            {step === 'done' && (
              <div className="mw-done">
                <p><ShieldCheck className="h-4 w-4" />{preset.name} 已就绪，24 个模型可在 Agent 页选用。</p>
                <div className="mw-form-actions">
                  <button type="button" className="mw-btn is-ghost" onClick={() => onAdded(preset)}>完成</button>
                  <button type="button" className="mw-btn is-primary" onClick={() => onAdded(preset)}>去给 Agent 选模型</button>
                </div>
              </div>
            )}
          </div>
        )}
      </aside>
    </div>
  );
}


function DiffPanel({ agent, onClose }: { agent: PrototypeAgent; onClose: () => void }) {
  const model = { id: agent.groupId ? `group/${agent.groupId}` : `${agent.providerId}/${agent.modelId}` };
  return (
    <div className="mw-sheet-layer" role="presentation" onClick={onClose}>
      <aside className="mw-sheet" role="dialog" aria-label="配置改动" onClick={(event) => event.stopPropagation()}>
        <header className="mw-sheet-head">
          <span className="mw-head-icon"><FileDiff className="h-4 w-4" /></span>
          <div className="mw-card-title"><strong>最近一次改动</strong><span>{agent.configPath}</span></div>
          <button type="button" className="mw-icon-btn" aria-label="关闭" onClick={onClose}><X className="h-4 w-4" /></button>
        </header>
        <pre className="mw-diff">
          <span className="is-ctx">{'# 其余内容与注释保持不变'}</span>{'\n'}
          <span className="is-del">{'- model = "gpt-5.5-mini"'}</span>{'\n'}
          <span className="is-add">{`+ model = "${model?.id ?? ''}"`}</span>{'\n'}
          <span className="is-ctx">{`  model_provider = "tokenledger"`}</span>{'\n'}
          <span className="is-ctx">{`  model_reasoning_effort = "${agent.effort}"`}</span>{'\n\n'}
          <span className="is-ctx">{'  [model_providers.tokenledger]'}</span>{'\n'}
          <span className="is-ctx">{'  name = "TokenLedger"'}</span>{'\n'}
          <span className="is-ctx">{'  base_url = "http://127.0.0.1:3462/v1"'}</span>{'\n'}
          <span className="is-ctx">{'  wire_api = "responses"'}</span>
        </pre>
        <p className="mw-caption">写入前已备份原文件。Agent 配置里只有网关地址和本地 token，没有供应商 key。</p>
        <section className="mw-sheet-section">
          <div className="mw-section-row"><h3>历史</h3></div>
          <ul className="mw-history">
            <li><span>23:42</span><span>模型 gpt-5.5-mini → {model?.id}</span><button type="button" className="mw-btn is-ghost"><Undo2 className="h-3.5 w-3.5" />恢复</button></li>
            <li><span>22:10</span><span>接入 TokenLedger 网关</span><button type="button" className="mw-btn is-ghost"><Undo2 className="h-3.5 w-3.5" />恢复</button></li>
          </ul>
        </section>
      </aside>
    </div>
  );
}


export default function ModelWorkspacePrototype() {
  const [page, setPage] = useState<Page>(initialPage);
  const [providers, setProviders] = useState(PROVIDERS);
  const [agents, setAgents] = useState(() => (params().get('toast')
    ? AGENTS.map((agent) => (agent.id === 'codex' ? { ...agent, groupId: null, providerId: 'deepseek', modelId: 'deepseek-chat' } : agent))
    : AGENTS));
  const [detailId, setDetailId] = useState<string | null>(() => params().get('detail'));
  const [addOpen, setAddOpen] = useState(() => params().get('sheet') === 'add');
  const [pickerFor, setPickerFor] = useState<string | null>(() => params().get('picker'));
  const [diffFor, setDiffFor] = useState<string | null>(() => params().get('diff'));
  const [toast, setToast] = useState<{ text: string; undo?: () => void } | null>(() => (
    params().get('toast') ? { text: 'Codex 已切换到 DeepSeek / DeepSeek V4，新会话生效', undo: () => undefined } : null
  ));

  useEffect(() => {
    const theme = params().get('theme');
    if (theme !== 'light' && theme !== 'dark') return;
    document.documentElement.setAttribute('data-theme', theme);
    document.documentElement.style.colorScheme = theme;
  }, []);
  const initialPreset = useMemo(() => {
    const id = params().get('preset');
    return PRESET_GROUPS.flatMap((group) => group.presets).find((item) => item.id === id) ?? null;
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 6000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const detail = providers.find((provider) => provider.id === detailId) ?? null;
  const switchAgent = (agentId: string, next: Partial<PrototypeAgent>, label: string) => {
    const before = agents;
    const agent = agents.find((item) => item.id === agentId);
    setAgents((list) => list.map((item) => (item.id === agentId ? { ...item, ...next } : item)));
    setPickerFor(null);
    setToast({ text: `${agent?.name} 已切换到 ${label}，新会话生效`, undo: () => setAgents(before) });
  };
  const meta = PAGES[page];
  const modelPage = page !== 'usage';

  return (
    <div className="app-shell mw-shell">
      <PrototypeSidebar page={page} onPage={setPage} />
      <main className="app-main">
        <header className="mw-header">
          <div>
            <h1>{meta.title}</h1>
            <p>{meta.subtitle}</p>
          </div>
          {modelPage && <button type="button" className="mw-gateway-pill" onClick={() => setPage('gateway')}><span className="mw-led" />网关运行中 · 127.0.0.1:3462</button>}
        </header>
        <section className="app-content tl-scrollbar mw-content" aria-label="主要内容">
          {page === 'usage' && <UsageView initialSub={initialSub()} />}
          {page === 'providers' && (
            <ProvidersView
              providers={providers}
              onOpen={setDetailId}
              onAdd={() => setAddOpen(true)}
              onToggle={(id) => setProviders((list) => list.map((provider) => (provider.id === id ? { ...provider, enabled: !provider.enabled } : provider)))}
            />
          )}
          {page === 'agents' && (
            <>
              <div className="mw-card mw-rows">
                {agents.map((agent) => (
                  <AgentRow
                    key={agent.id}
                    agent={agent}
                    providers={providers}
                    pickerOpen={pickerFor === agent.id}
                    onTogglePicker={() => setPickerFor((current) => (current === agent.id ? null : agent.id))}
                    onPick={(providerId, modelId) => {
                      const provider = providers.find((item) => item.id === providerId);
                      const model = provider?.models.find((item) => item.id === modelId);
                      switchAgent(agent.id, { groupId: null, providerId, modelId }, `${provider?.name} / ${model?.name}`);
                    }}
                    onPickGroup={(groupId) => switchAgent(agent.id, { groupId, providerId: null, modelId: null }, `路由组 ${ROUTING_GROUPS.find((group) => group.id === groupId)?.name}`)}
                    onEffort={(effort) => setAgents((list) => list.map((item) => (item.id === agent.id ? { ...item, effort } : item)))}
                    onShowDiff={() => setDiffFor(agent.id)}
                  />
                ))}
              </div>
              <p className="mw-caption mw-list-note">只显示本机已安装的 Agent。选路由组后，切换模型在路由页完成，不用再改 Agent 配置。</p>
            </>
          )}
          {page === 'gateway' && <GatewayView onOpenRecords={() => setPage('usage')} onOpenRouting={() => setPage('routing')} />}
          {page === 'routing' && <RoutingView />}
        </section>
        {toast && (
          <div className="mw-toast" role="status">
            <Check className="h-4 w-4" />
            <span>{toast.text}</span>
            {toast.undo && <button type="button" onClick={() => { toast.undo?.(); setToast(null); }}>撤销</button>}
          </div>
        )}
      </main>
      {detail && (
        <ProviderDetail
          provider={detail}
          onClose={() => setDetailId(null)}
          onToggleModel={(modelId) => setProviders((list) => list.map((provider) => (provider.id === detail.id
            ? { ...provider, models: provider.models.map((model) => (model.id === modelId ? { ...model, exposed: !model.exposed } : model)) }
            : provider)))}
        />
      )}
      {addOpen && (
        <AddProviderSheet
          initialPreset={initialPreset}
          onClose={() => setAddOpen(false)}
          onAdded={(preset) => {
            setAddOpen(false);
            setToast({ text: `${preset.name} 已添加` });
            setPage('agents');
          }}
        />
      )}
      {diffFor && <DiffPanel agent={agents.find((agent) => agent.id === diffFor)!} onClose={() => setDiffFor(null)} />}
    </div>
  );
}
