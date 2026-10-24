import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, ClipboardList, FileDiff, LoaderCircle, Plus, Search, Undo2, Waypoints } from 'lucide-react';
import { EmptyState } from '../../components/EmptyState';
import { BrandIcon, GroupIcon } from '../../prototypes/prototypeKit';
import type { ToastType } from '../../types';
import type { RequestConfirmation } from '../../utils/confirmation';
import { MANUAL_AGENTS, PENDING_AGENTS, SUPPORTED_AGENTS, type AgentAdapter, type ManualAgent, type ManualField, type PendingAgent } from './agents';
import { errorText, gatewayStatus, listProviders, listRoutingGroups, revealLocalToken } from './api';
import { diffLineClass, modelOptions, type ModelOption } from './helpers';
import type { AgentInspection, AgentPreview } from './types';
import { CopyButton, RevealCopyButton, Sheet } from './ui';
import { LegacyRestoreCard } from './LegacyRestoreCard';
import { useT } from '../../i18n';

const DEFAULT_BASE_URL = 'http://127.0.0.1:3462/v1';

interface PageProps {
  onNotify: (type: ToastType, text: string) => void;
  onConfirm: RequestConfirmation;
  supported?: AgentAdapter[];
  manual?: ManualAgent[];
  pending?: PendingAgent[];
  /** Shown as the next step while there is no model to pick yet. */
  onOpenProviders?: () => void;
}

function ModelPicker({ agentName, options, current, onPick, onClose }: {
  agentName: string;
  options: ModelOption[];
  current: string | null;
  onPick: (value: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const q = query.trim().toLowerCase();
  const filtered = options.filter((option) => `${option.value} ${option.section}`.toLowerCase().includes(q));
  const sections = [...new Set(filtered.map((option) => option.section))];
  return (
    <div className="mw-popover" role="dialog" aria-label={`为 ${agentName} 选择模型`}>
      <label className="mw-search is-compact">
        <Search className="h-4 w-4" aria-hidden="true" />
        <input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索模型或路由组" aria-label="搜索模型" />
      </label>
      <div className="mw-popover-body tl-scrollbar">
        {sections.length === 0 && <p className="mw-caption">没有可选模型。先在供应商页启用供应商并列出模型。</p>}
        {sections.map((section) => (
          <section key={section}>
            <h4>{filtered.find((option) => option.section === section)?.isGroup && <GroupIcon size={16} />}{section}</h4>
            {filtered.filter((option) => option.section === section).map((option) => (
              <button key={option.value} type="button" className={`mw-pick ${current === option.value ? 'is-current' : ''}`} onClick={() => onPick(option.value)}>
                <span><strong>{option.label}</strong><small>{option.value}</small></span>
                {current === option.value && <Check className="h-4 w-4" />}
              </button>
            ))}
          </section>
        ))}
      </div>
      <footer className="mw-popover-foot">选择后先预览配置改动，确认才写入</footer>
    </div>
  );
}

function DiffSheet({ agent, model, preview, busy, onApply, onClose }: {
  agent: AgentAdapter;
  model: string;
  preview: AgentPreview;
  busy: boolean;
  onApply: () => void;
  onClose: () => void;
}) {
  return (
    <Sheet title={`${agent.name} 配置改动`} subtitle={preview.configPath} icon={<span className="mw-head-icon"><FileDiff className="h-4 w-4" /></span>} onClose={onClose}>
      <div className="mw-editor">
        <p className="mw-caption">目标模型 <span className="mw-mono-text">{model}</span>。写入前备份原文件，只改网关相关的键，其余内容与注释保持不变。配置里只有网关地址和本地 token，没有供应商 key。</p>
        {preview.warnings.length > 0 && (
          <ul className="mw-warning-list">{preview.warnings.map((warning) => <li key={warning} className="mw-note is-warning">{warning}</li>)}</ul>
        )}
        {preview.changed ? (
          <pre className="mw-diff mw-diff-lines" aria-label="配置 diff">
            {preview.diff.split('\n').map((line, index) => <span key={index} className={diffLineClass(line)}>{line}{'\n'}</span>)}
          </pre>
        ) : <p className="mw-note">配置已经是这个模型，无需改动。</p>}
        <div className="mw-form-actions">
          <button type="button" className="mw-btn is-ghost" onClick={onClose}>取消</button>
          <button type="button" className="mw-btn is-primary" disabled={busy || !preview.changed} onClick={onApply}>{busy ? '写入中…' : '写入配置'}</button>
        </div>
      </div>
    </Sheet>
  );
}

function AgentRow({ agent, options, onNotify, onConfirm, startPicker = false }: { agent: AgentAdapter; options: ModelOption[]; onNotify: PageProps['onNotify']; onConfirm: RequestConfirmation; startPicker?: boolean }) {
  const [inspection, setInspection] = useState<AgentInspection | null>(null);
  const initialPickerOpened = useRef(false);
  const [inspectError, setInspectError] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pending, setPending] = useState<{ model: string; preview: AgentPreview } | null>(null);
  const [busy, setBusy] = useState(false);

  const inspect = useCallback(async () => {
    try {
      setInspection(await agent.inspect());
      setInspectError('');
    } catch (error) {
      setInspectError(errorText(error));
    }
  }, [agent]);
  useEffect(() => { void inspect(); }, [inspect]);
  useEffect(() => {
    if (startPicker && inspection && !initialPickerOpened.current) { initialPickerOpened.current = true; setPickerOpen(true); }
  }, [startPicker, inspection]);

  const pick = async (model: string) => {
    setPickerOpen(false);
    setBusy(true);
    try {
      setPending({ model, preview: await agent.preview(model) });
    } catch (error) {
      onNotify('error', errorText(error));
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (!pending) return;
    setBusy(true);
    try {
      await agent.apply(pending.model, pending.preview.beforeVersion);
      onNotify('success', `${agent.name} 已切换到 ${pending.model}，新会话生效`);
      setPending(null);
      await inspect();
    } catch (error) {
      onNotify('error', errorText(error));
    } finally {
      setBusy(false);
    }
  };

  const restore = async () => {
    const backup = inspection?.backup;
    if (!backup) return;
    const force = !backup.restorableWithoutForce;
    const confirmed = await onConfirm(force
      ? { title: `强制恢复 ${agent.name} 配置？`, description: '接入后配置文件又被改过，恢复会覆盖这些改动，回到接入前的备份。', confirmLabel: '强制恢复', tone: 'danger' }
      : { title: `恢复 ${agent.name} 配置？`, description: backup.originalExisted ? '回到接入网关前的备份。' : '接入前没有配置文件，恢复会删除它。', confirmLabel: '恢复' });
    if (!confirmed) return;
    setBusy(true);
    try {
      await agent.restore(force);
      onNotify('success', `${agent.name} 配置已恢复`);
      await inspect();
    } catch (error) {
      onNotify('error', errorText(error));
    } finally {
      setBusy(false);
    }
  };

  const onGateway = Boolean(inspection?.pointsToGateway);
  const current = onGateway ? inspection?.model ?? null : null;
  const currentOption = options.find((option) => option.value === current);

  return (
    <div className="mw-row mw-agent">
      <BrandIcon id={agent.icon} fallback={agent.monogram} size={30} />
      <span className="mw-row-title">
        <strong>{agent.name}</strong>
        <small className="mw-mono-text">{inspection?.configPath ?? '读取配置…'}</small>
        <span className="mw-agent-status">
          {inspectError && <span className="mw-chip is-danger" title={inspectError}>读取失败</span>}
          {inspection && (onGateway
            ? <span className="mw-chip is-success">已接入网关</span>
            : <span className="mw-chip">{inspection.exists ? `未接入 · 当前 ${inspection.model ?? '默认模型'}` : '未找到配置，写入时创建'}</span>)}
          {inspection?.warnings.map((warning) => <span key={warning} className="mw-chip is-warning" title={warning}>注意</span>)}
        </span>
      </span>
      <div className="mw-field-col">
        <button type="button" className={`mw-value-btn ${pickerOpen ? 'is-open' : ''}`} aria-expanded={pickerOpen} aria-label={`${agent.name} 模型`} disabled={busy || !inspection} onClick={() => setPickerOpen((open) => !open)}>
          {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : currentOption?.isGroup ? <GroupIcon size={18} /> : null}
          <span><strong>{current ? currentOption?.label ?? current : '选择模型'}</strong><small>{current ?? '经网关转发'}</small></span>
          <ChevronDown className="h-3.5 w-3.5" />
        </button>
        {pickerOpen && <ModelPicker agentName={agent.name} options={options} current={current} onPick={(value) => void pick(value)} onClose={() => setPickerOpen(false)} />}
      </div>
      <div className="mw-agent-actions">
        {inspection?.backup && (
          <button type="button" className="mw-btn is-ghost" disabled={busy} onClick={() => void restore()} title={`备份于 ${inspection.backup.createdAt}`}>
            <Undo2 className="h-3.5 w-3.5" />恢复
          </button>
        )}
      </div>
      {pending && <DiffSheet agent={agent} model={pending.model} preview={pending.preview} busy={busy} onApply={() => void apply()} onClose={() => setPending(null)} />}
    </div>
  );
}

function ManualSheet({ agent, baseUrl, options, onClose }: { agent: ManualAgent; baseUrl: string; options: ModelOption[]; onClose: () => void }) {
  const [picked, setModel] = useState('');
  const model = picked || options[0]?.value || '';
  const gatewayRoot = baseUrl.replace(/\/v1\/?$/, '');
  const value = (field: ManualField) => {
    switch (field.value.kind) {
      case 'text': return <><span className="mw-copy-value">{field.value.text}</span><CopyButton text={field.value.text} label={`复制 ${field.label}`} /></>;
      case 'baseUrl': return <><span className="mw-copy-value is-mono">{baseUrl}</span><CopyButton text={baseUrl} label={`复制 ${field.label}`} /></>;
      case 'gatewayRoot': return <><span className="mw-copy-value is-mono">{gatewayRoot}</span><CopyButton text={gatewayRoot} label={`复制 ${field.label}`} /></>;
      case 'token': return <RevealCopyButton resolve={revealLocalToken} label={`复制 ${field.label}（本地 token）`}>复制本地 token</RevealCopyButton>;
      case 'model': return options.length === 0
        ? <span className="mw-caption">没有可选模型。先在供应商页启用供应商并列出模型。</span>
        : <>
          <select className="mw-native-select is-compact" aria-label={`${agent.name} 模型`} value={model} onChange={(event) => setModel(event.target.value)}>
            {options.map((option) => <option key={option.value} value={option.value}>{option.value}</option>)}
          </select>
          <CopyButton text={model} label={`复制 ${field.label}`} />
        </>;
    }
  };
  return (
    <Sheet title={`${agent.name} 手动配置`} subtitle="复制以下设置到 Agent 里" icon={<span className="mw-head-icon"><ClipboardList className="h-4 w-4" /></span>} onClose={onClose}>
      <div className="mw-editor">
        <p className="mw-note is-warning">{agent.reason}</p>
        <p className="mw-caption">{agent.where}</p>
        {agent.steps && (
          <ol className="mw-warning-list" aria-label={`${agent.name} 配置步骤`}>
            {agent.steps.map((step, index) => <li key={step} className="mw-caption">{index + 1}. {step}</li>)}
          </ol>
        )}
        <div className="mw-connect-fields">
          {agent.fields.map((field) => (
            <div key={field.label} className="mw-copy-field">
              <span className="mw-copy-label">{field.label}</span>
              {value(field)}
            </div>
          ))}
        </div>
        {agent.fields.filter((field) => field.hint).map((field) => <p key={field.label} className="mw-caption">{field.label}：{field.hint}</p>)}
        {agent.notes && (
          <ul className="mw-warning-list">{agent.notes.map((note) => <li key={note} className="mw-note">{note}</li>)}</ul>
        )}
        <p className="mw-caption">本地 token 只在点击时读取并写入剪贴板，不在界面显示。选路由组后，切换成员在路由页完成，不用再改 Agent 设置。</p>
      </div>
    </Sheet>
  );
}

function ManualRow({ agent, baseUrl, options }: { agent: ManualAgent; baseUrl: string; options: ModelOption[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mw-row mw-agent">
      <BrandIcon id={agent.icon} fallback={agent.monogram} size={30} />
      <span className="mw-row-title">
        <strong>{agent.name}</strong>
        <small>{agent.reason}</small>
        <span className="mw-agent-status"><span className="mw-chip">手动配置</span></span>
      </span>
      <div className="mw-agent-actions">
        <button type="button" className="mw-btn is-ghost" onClick={() => setOpen(true)}>
          <ClipboardList className="h-3.5 w-3.5" />配置步骤
        </button>
      </div>
      {open && <ManualSheet agent={agent} baseUrl={baseUrl} options={options} onClose={() => setOpen(false)} />}
    </div>
  );
}

export function AgentsPage({ onNotify, onConfirm, supported = SUPPORTED_AGENTS, manual = MANUAL_AGENTS, pending = PENDING_AGENTS, onOpenProviders }: PageProps) {
  const t = useT();
  const [options, setOptions] = useState<ModelOption[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [baseUrl, setBaseUrl] = useState(DEFAULT_BASE_URL);
  const [legacyResolution, setLegacyResolution] = useState({ revision: 0, chooseGateway: false });

  useEffect(() => {
    let cancelled = false;
    Promise.all([listProviders(), listRoutingGroups()])
      .then(([providers, groups]) => { if (!cancelled) setOptions(modelOptions(providers, groups)); })
      .catch((error) => { if (!cancelled) setLoadError(errorText(error)); });
    if (manual.length > 0) {
      gatewayStatus()
        .then((status) => { if (!cancelled) setBaseUrl(status.baseUrl ?? `http://127.0.0.1:${status.port}/v1`); })
        .catch(() => {});
    }
    return () => { cancelled = true; };
  }, [manual.length]);

  return (
    <>
      <LegacyRestoreCard onConfirm={onConfirm} onResolved={(chooseGateway) => setLegacyResolution((previous) => ({ revision: previous.revision + 1, chooseGateway }))} />
      <div className="mw-toolbar">
        <span className="mw-caption">{options?.length ?? 0} 个可选模型与路由组 · Agent 配置只写网关地址和本地 token</span>
      </div>
      {loadError && <p className="mw-note is-danger" role="alert">读取模型列表失败：{loadError}</p>}
      {options?.length === 0 && (
        <EmptyState variant="banner" icon={Waypoints} title={t('empty.agents.title')} description={t('empty.agents.description')}>
          {onOpenProviders && <button type="button" className="mw-btn is-primary" onClick={onOpenProviders}><Plus className="h-4 w-4" />{t('empty.agents.action')}</button>}
        </EmptyState>
      )}
      <div className="mw-card mw-rows">
        {supported.map((agent) => <AgentRow key={`${agent.id}:${legacyResolution.revision}`} agent={agent} options={options ?? []} onNotify={onNotify} onConfirm={onConfirm} startPicker={agent.id === 'codex' && legacyResolution.chooseGateway} />)}
        {manual.map((agent) => <ManualRow key={agent.id} agent={agent} baseUrl={baseUrl} options={options ?? []} />)}
        {pending.map((agent) => (
          <div key={agent.id} className="mw-row mw-agent is-off">
            <BrandIcon id={agent.icon} fallback={agent.monogram} size={30} />
            <span className="mw-row-title"><strong>{agent.name}</strong>{agent.note && <small>{agent.note}</small>}</span>
            <span className="mw-agent-soon"><span className="mw-chip">即将支持</span></span>
          </div>
        ))}
      </div>
      <p className="mw-caption mw-list-note">选路由组后，切换成员在路由页完成，不用再改 Agent 配置。</p>
    </>
  );
}

export default AgentsPage;
