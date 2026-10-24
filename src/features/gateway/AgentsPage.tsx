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
import { t, useLang } from '../../i18n';

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
    <div className="mw-popover" role="dialog" aria-label={t('agents.picker.aria', { name: agentName })}>
      <label className="mw-search is-compact">
        <Search className="h-4 w-4" aria-hidden="true" />
        <input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('agents.picker.placeholder')} aria-label={t('agents.picker.searchAria')} />
      </label>
      <div className="mw-popover-body tl-scrollbar">
        {sections.length === 0 && <p className="mw-caption">{t('agents.noModels')}</p>}
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
      <footer className="mw-popover-foot">{t('agents.picker.foot')}</footer>
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
    <Sheet title={t('agents.diff.title', { name: agent.name })} subtitle={preview.configPath} icon={<span className="mw-head-icon"><FileDiff className="h-4 w-4" /></span>} onClose={onClose}>
      <div className="mw-editor">
        <p className="mw-caption">{t('agents.diff.target')} <span className="mw-mono-text">{model}</span>{t('agents.diff.note')}</p>
        {preview.warnings.length > 0 && (
          <ul className="mw-warning-list">{preview.warnings.map((warning) => <li key={warning} className="mw-note is-warning">{warning}</li>)}</ul>
        )}
        {preview.changed ? (
          <pre className="mw-diff mw-diff-lines" aria-label={t('agents.diff.aria')}>
            {preview.diff.split('\n').map((line, index) => <span key={index} className={diffLineClass(line)}>{line}{'\n'}</span>)}
          </pre>
        ) : <p className="mw-note">{t('agents.diff.unchanged')}</p>}
        <div className="mw-form-actions">
          <button type="button" className="mw-btn is-ghost" onClick={onClose}>{t('agents.cancel')}</button>
          <button type="button" className="mw-btn is-primary" disabled={busy || !preview.changed} onClick={onApply}>{busy ? t('agents.writing') : t('agents.write')}</button>
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
      onNotify('success', t('agents.toast.switched', { name: agent.name, model: pending.model }));
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
      ? { title: t('agents.restore.forceTitle', { name: agent.name }), description: t('agents.restore.forceBody'), confirmLabel: t('agents.restore.forceLabel'), tone: 'danger' }
      : { title: t('agents.restore.title', { name: agent.name }), description: t(backup.originalExisted ? 'agents.restore.body' : 'agents.restore.bodyDelete'), confirmLabel: t('agents.restore.label') });
    if (!confirmed) return;
    setBusy(true);
    try {
      await agent.restore(force);
      onNotify('success', t('agents.toast.restored', { name: agent.name }));
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
        <small className="mw-mono-text">{inspection?.configPath ?? t('agents.reading')}</small>
        <span className="mw-agent-status">
          {inspectError && <span className="mw-chip is-danger" title={inspectError}>{t('agents.readFailed')}</span>}
          {inspection && (onGateway
            ? <span className="mw-chip is-success">{t('agents.connected')}</span>
            : <span className="mw-chip">{inspection.exists ? t('agents.notConnected', { model: inspection.model ?? t('agents.defaultModel') }) : t('agents.noConfig')}</span>)}
          {inspection?.warnings.map((warning) => <span key={warning} className="mw-chip is-warning" title={warning}>{t('agents.warning')}</span>)}
        </span>
      </span>
      <div className="mw-field-col">
        <button type="button" className={`mw-value-btn ${pickerOpen ? 'is-open' : ''}`} aria-expanded={pickerOpen} aria-label={t('agents.modelAria', { name: agent.name })} disabled={busy || !inspection} onClick={() => setPickerOpen((open) => !open)}>
          {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : currentOption?.isGroup ? <GroupIcon size={18} /> : null}
          <span><strong>{current ? currentOption?.label ?? current : t('agents.pickModel')}</strong><small>{current ?? t('agents.viaGateway')}</small></span>
          <ChevronDown className="h-3.5 w-3.5" />
        </button>
        {pickerOpen && <ModelPicker agentName={agent.name} options={options} current={current} onPick={(value) => void pick(value)} onClose={() => setPickerOpen(false)} />}
      </div>
      <div className="mw-agent-actions">
        {inspection?.backup && (
          <button type="button" className="mw-btn is-ghost" disabled={busy} onClick={() => void restore()} title={t('agents.backupAt', { time: inspection.backup.createdAt })}>
            <Undo2 className="h-3.5 w-3.5" />{t('agents.restore.label')}
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
      case 'text': return <><span className="mw-copy-value">{field.value.text}</span><CopyButton text={field.value.text} label={t('agents.copy', { label: field.label })} /></>;
      case 'baseUrl': return <><span className="mw-copy-value is-mono">{baseUrl}</span><CopyButton text={baseUrl} label={t('agents.copy', { label: field.label })} /></>;
      case 'gatewayRoot': return <><span className="mw-copy-value is-mono">{gatewayRoot}</span><CopyButton text={gatewayRoot} label={t('agents.copy', { label: field.label })} /></>;
      case 'token': return <RevealCopyButton resolve={revealLocalToken} label={t('agents.copyToken', { label: field.label })}>{t('agents.copyTokenButton')}</RevealCopyButton>;
      case 'model': return options.length === 0
        ? <span className="mw-caption">{t('agents.noModels')}</span>
        : <>
          <select className="mw-native-select is-compact" aria-label={t('agents.modelAria', { name: agent.name })} value={model} onChange={(event) => setModel(event.target.value)}>
            {options.map((option) => <option key={option.value} value={option.value}>{option.value}</option>)}
          </select>
          <CopyButton text={model} label={t('agents.copy', { label: field.label })} />
        </>;
    }
  };
  return (
    <Sheet title={t('agents.manual.title', { name: agent.name })} subtitle={t('agents.manual.subtitle')} icon={<span className="mw-head-icon"><ClipboardList className="h-4 w-4" /></span>} onClose={onClose}>
      <div className="mw-editor">
        <p className="mw-note is-warning">{agent.reason}</p>
        <p className="mw-caption">{agent.where}</p>
        {agent.steps && (
          <ol className="mw-warning-list" aria-label={t('agents.manual.stepsAria', { name: agent.name })}>
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
        {agent.fields.filter((field) => field.hint).map((field) => <p key={field.label} className="mw-caption">{t('agents.manual.hint', { label: field.label, hint: field.hint ?? '' })}</p>)}
        {agent.notes && (
          <ul className="mw-warning-list">{agent.notes.map((note) => <li key={note} className="mw-note">{note}</li>)}</ul>
        )}
        <p className="mw-caption">{t('agents.manual.tokenNote')}</p>
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
        <span className="mw-agent-status"><span className="mw-chip">{t('agents.manual.chip')}</span></span>
      </span>
      <div className="mw-agent-actions">
        <button type="button" className="mw-btn is-ghost" onClick={() => setOpen(true)}>
          <ClipboardList className="h-3.5 w-3.5" />{t('agents.manual.steps')}
        </button>
      </div>
      {open && <ManualSheet agent={agent} baseUrl={baseUrl} options={options} onClose={() => setOpen(false)} />}
    </div>
  );
}

export function AgentsPage({ onNotify, onConfirm, supported = SUPPORTED_AGENTS, manual = MANUAL_AGENTS, pending = PENDING_AGENTS, onOpenProviders }: PageProps) {
  useLang();
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
        <span className="mw-caption">{t('agents.toolbar', { count: options?.length ?? 0 })}</span>
      </div>
      {loadError && <p className="mw-note is-danger" role="alert">{t('agents.loadFailed', { error: loadError })}</p>}
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
            <span className="mw-agent-soon"><span className="mw-chip">{t('agents.soon')}</span></span>
          </div>
        ))}
      </div>
      <p className="mw-caption mw-list-note">{t('agents.groupNote')}</p>
    </>
  );
}

export default AgentsPage;
