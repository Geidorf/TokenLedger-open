import { emit } from '@tauri-apps/api/event';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { ChevronDown, ChevronRight, KeyRound, Plug, Plus, Search, Wallet } from 'lucide-react';
import { EmptyState } from '../../components/EmptyState';
import { BrandIcon } from '../../prototypes/prototypeKit';
import type { RequestConfirmation } from '../../utils/confirmation';
import type { ToastType } from '../../types';
import { deleteProvider, errorText, listProviders, setProviderKey, upsertProvider } from './api';
import { parseModels, slugId } from './helpers';
import { hostOf, PROVIDER_PRESET_GROUPS, type ProviderPreset } from './presets';
import { healthByProvider, HealthBadge, HealthDetail, HealthSpark, ProbeBar, useHealthReport } from './ProviderHealth';
import type { ProviderHealth, ProviderRecord, ProviderView, WireApi } from './types';
import { beginProviderSave, clearProviderDraft, endProviderSave, readProviderDraft, useProviderSaving, writeProviderDraft } from './providerDrafts';
import { ProviderIcon, Sheet } from './ui';
import { t, useLang } from '../../i18n';

interface PageProps {
  onNotify: (type: ToastType, text: string) => void;
  onConfirm: RequestConfirmation;
  onChanged?: () => void;
}

const WIRE_OPTIONS: { value: WireApi; label: string }[] = [
  { value: 'chat', label: 'Chat Completions' },
  { value: 'responses', label: 'Responses' },
  { value: 'anthropic', label: 'Anthropic Messages' },
];

const WIRE_SHORT: Record<WireApi, string> = { chat: 'Chat', responses: 'Responses', anthropic: 'Anthropic' };

function KeyState({ provider }: { provider: ProviderView }) {
  if (provider.authMode === 'none') return <span className="mw-chip">{t('providers.key.none')}</span>;
  if (provider.hasKey) return <span className="mw-chip is-success">{t('providers.key.set')}</span>;
  return <span className="mw-chip is-warning">{t('providers.key.missing')}</span>;
}

const OFFICIAL_BALANCE_HOSTS = new Set(['api.moonshot.cn', 'api.moonshot.ai', 'api.deepseek.com', 'openrouter.ai', 'api.siliconflow.cn', 'api.siliconflow.com']);

export function balanceEntryHint(baseUrl: string): string {
  return OFFICIAL_BALANCE_HOSTS.has(hostOf(baseUrl).toLowerCase())
    ? t('providers.balance.official')
    : t('providers.balance.relay');
}

function openBalanceSettings() {
  void emit('open-settings', { anchor: 'settings-quota' })
    .catch(() => {
      window.location.hash = '#settings-quota';
    });
}

function BalanceEntry({ provider }: { provider: ProviderView }) {
  return (
    <div className="mw-key-row">
      <Wallet className="h-4 w-4" aria-hidden="true" />
      <span>{t('providers.balance.label', { hint: balanceEntryHint(provider.baseUrl) })}</span>
      <button type="button" className="mw-btn is-ghost" onClick={openBalanceSettings} aria-label={t('providers.balance.aria', { name: provider.name })}>{t('providers.balance.view')}</button>
    </div>
  );
}

function ProviderRow({ provider, health, onOpen, onToggle, busy }: { provider: ProviderView; health?: ProviderHealth; onOpen: () => void; onToggle: () => void; busy: boolean }) {
  return (
    <div className={`mw-row ${provider.enabled ? '' : 'is-off'}`}>
      <button type="button" className="mw-row-main" onClick={onOpen}>
        <ProviderIcon provider={provider} size={28} />
        <span className="mw-row-title">
          <strong>{provider.name}</strong>
          <small>{t('providers.row.meta', { host: hostOf(provider.baseUrl), count: provider.models.length, wire: WIRE_SHORT[provider.wire] ?? provider.wire })}</small>
        </span>
        <span className="mw-row-meta">
          {health && health.stats.requests > 0 && <HealthSpark buckets={health.buckets} label={provider.name} />}
          {provider.enabled && <HealthBadge health={health} />}
          <KeyState provider={provider} />
        </span>
      </button>
      <button type="button" role="switch" aria-checked={provider.enabled} aria-label={t('providers.row.enableAria', { name: provider.name })} disabled={busy} className={`mw-switch ${provider.enabled ? 'is-on' : ''}`} onClick={onToggle}><span /></button>
      <ChevronRight className="mw-row-arrow" aria-hidden="true" />
    </div>
  );
}

interface FormState {
  id: string;
  name: string;
  baseUrl: string;
  wire: WireApi;
  authMode?: 'key' | 'none';
  models: string;
  key: string;
}

function ProviderForm({ target, initial, isNew, hasKey, busy, onSubmit, onBack, onDeleteKey }: {
  target: string;
  initial: FormState;
  isNew: boolean;
  hasKey: boolean;
  busy: boolean;
  onSubmit: (form: FormState) => void;
  onBack?: () => void;
  onDeleteKey?: () => void;
}) {
  const saving = useProviderSaving(target);
  const disabled = busy || saving;
  const [form, setForm] = useState<FormState>(() => ({ ...initial, ...readProviderDraft(target), key: '' }));
  const set = (patch: Partial<FormState>) => setForm((current) => {
    const next = { ...current, ...patch };
    writeProviderDraft(target, next);
    return next;
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (disabled) return;
    onSubmit(form);
    setForm((current) => ({ ...current, key: '' }));
  };
  return (
    <form className="mw-add-form" onSubmit={submit}>
      <fieldset disabled={disabled} style={{ border: 0, padding: 0, margin: 0, minWidth: 0, display: 'contents' }}>
      <label className="mw-field"><span>{t('providers.form.name')}</span><input value={form.name} onChange={(event) => set({ name: event.target.value })} placeholder={t('providers.form.namePlaceholder')} required /></label>
      {isNew && <label className="mw-field"><span>ID</span><input value={form.id} onChange={(event) => set({ id: event.target.value })} required /><small>{t('providers.form.idHint')}</small></label>}
      <label className="mw-field"><span>{t('providers.form.baseUrl')}</span><input value={form.baseUrl} onChange={(event) => set({ baseUrl: event.target.value })} placeholder="https://relay.example.com/v1" required /><small>{t(form.wire === 'anthropic' ? 'providers.form.baseUrlAnthropic' : 'providers.form.baseUrlOpenai')}</small></label>
      <label className="mw-field">
        <span>{t('providers.form.wire')}</span>
        <select className="mw-native-select" value={form.wire} onChange={(event) => set({ wire: event.target.value as WireApi })}>
          {WIRE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
        <small>{t('providers.form.wireHint')}</small>
      </label>
      <label className="mw-field"><span>{t('providers.form.auth')}</span><select className="mw-native-select" value={form.authMode ?? 'key'} onChange={(event) => set({ authMode: event.target.value as 'key' | 'none' })}><option value="key">API key</option><option value="none">{t('providers.form.authNone')}</option></select><small>{t('providers.form.authHint')}</small></label>
      <label className="mw-field"><span>{t('providers.form.models')}</span><textarea rows={3} value={form.models} onChange={(event) => set({ models: event.target.value })} placeholder={t('providers.form.modelsPlaceholder')} /><small>{t('providers.form.modelsHint')}</small></label>
      {form.authMode !== 'none' && (
        <label className="mw-field">
          <span>API key {hasKey && <span className="mw-chip is-success">{t('providers.form.keySet')}</span>}</span>
          <input type="password" autoComplete="off" value={form.key} onChange={(event) => set({ key: event.target.value })} placeholder={hasKey ? t('providers.form.keyKeep') : 'sk-…'} />
          <small>{t('providers.form.keyHint')}</small>
        </label>
      )}
      {form.authMode !== 'none' && hasKey && onDeleteKey && (
        <div className="mw-key-row"><KeyRound className="h-4 w-4" aria-hidden="true" /><span>{t('providers.key.set')}</span><button type="button" className="mw-btn is-ghost" disabled={busy} onClick={onDeleteKey}>{t('providers.form.deleteKey')}</button></div>
      )}
      <div className="mw-form-actions">
        {onBack && <button type="button" className="mw-btn is-ghost" onClick={onBack}>{t('providers.form.back')}</button>}
        <button type="button" className="mw-btn is-ghost" disabled={disabled} onClick={() => { clearProviderDraft(target); setForm({ ...initial, key: '' }); }}>{t('providers.form.discard')}</button>
        <button type="submit" className="mw-btn is-primary" disabled={disabled}>{disabled ? t('providers.form.saving') : t('providers.form.save')}</button>
      </div>
      </fieldset>
    </form>
  );
}


function PresetPicker({ onPick }: { onPick: (preset: ProviderPreset) => void }) {
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const groups = PROVIDER_PRESET_GROUPS.map((group) => ({
    ...group,
    presets: group.presets.filter((preset) => `${preset.name} ${preset.baseUrl}`.toLowerCase().includes(q)),
  })).filter((group) => group.presets.length > 0);
  return (
    <>
      <label className="mw-search">
        <Search className="h-4 w-4" aria-hidden="true" />
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('providers.search.placeholder')} aria-label={t('providers.search.aria')} />
      </label>
      <div className="mw-preset-groups">
        {groups.map((group) => (
          <section key={group.id}>
            <h3>{group.label}</h3>
            <div className="mw-preset-grid">
              {group.presets.map((preset) => (
                <button key={preset.id} type="button" className="mw-preset" onClick={() => onPick(preset)}>
                  <BrandIcon id={preset.icon} fallback={preset.monogram} size={22} />
                  <span><strong>{preset.name}</strong><small>{preset.keyless ? t('providers.preset.local') : preset.custom ? t('providers.preset.custom') : hostOf(preset.baseUrl)}</small></span>
                </button>
              ))}
            </div>
          </section>
        ))}
      </div>
    </>
  );
}

export function ProvidersPage({ onNotify, onConfirm, onChanged }: PageProps) {
  useLang();
  const [providers, setProviders] = useState<ProviderView[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState(false);
  const saving = useProviderSaving();
  const mounted = useRef(false);
  const editSession = useRef(0);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [showOff, setShowOff] = useState(false);
  const [adding, setAdding] = useState<ProviderPreset | 'pick' | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [healthReport, setHealthReport] = useHealthReport();
  const health = useMemo(() => healthByProvider(healthReport), [healthReport]);

  const load = useCallback(async () => {
    try {
      setProviders(await listProviders());
      setLoadError('');
    } catch (error) {
      setLoadError(errorText(error));
    }
  }, []);
  useEffect(() => { void load(); }, [load, saving]);

  const run = async (action: () => Promise<ProviderView[] | void>, success?: string) => {
    setBusy(true);
    try {
      const next = await action();
      if (next) setProviders(next);
      else await load();
      if (success) onNotify('success', success);
      onChanged?.();
      return true;
    } catch (error) {
      onNotify('error', errorText(error));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const save = async (form: FormState, existing: ProviderView | null, target: string) => {
    if (!beginProviderSave(target)) return;
    const session = editSession.current;
    const record: ProviderRecord = {
      id: existing?.id ?? form.id.trim(),
      name: form.name.trim(),
      baseUrl: form.baseUrl.trim(),
      wire: form.wire,
      authMode: form.authMode ?? 'key',
      models: parseModels(form.models),
      enabled: existing?.enabled ?? true,
    };
    try {
      const ok = await run(async () => {
        const next = await upsertProvider(record);
        if (form.key.trim()) {
          try {
            await setProviderKey(record.id, form.key.trim());
          } catch (error) {
            setProviders(next);
            throw new Error(t('providers.toast.keyFailed', { error: errorText(error) }));
          }
          return listProviders();
        }
        return next;
      }, t(existing ? 'providers.toast.saved' : 'providers.toast.added', { name: record.name }));
      if (ok) {
        clearProviderDraft(target);
        if (mounted.current && editSession.current === session) {
          setAdding(null);
          setEditingId(null);
        }
      }
    } finally { endProviderSave(target); }
  };

  const toggle = (provider: ProviderView) => {
    const { id, name, baseUrl, wire, models, authMode } = provider;
    void run(() => upsertProvider({ id, name, baseUrl, wire, models, authMode: authMode ?? 'key', enabled: !provider.enabled }));
  };

  const removeKey = async (provider: ProviderView) => {
    const confirmed = await onConfirm({ title: t('providers.confirm.deleteKeyTitle', { name: provider.name }), description: t('providers.confirm.deleteKeyBody'), confirmLabel: t('providers.form.deleteKey'), tone: 'danger' });
    if (confirmed) await run(() => setProviderKey(provider.id, ''), t('providers.toast.keyDeleted'));
  };

  const remove = async (provider: ProviderView) => {
    const confirmed = await onConfirm({ title: t('providers.confirm.deleteTitle', { name: provider.name }), description: t('providers.confirm.deleteBody'), confirmLabel: t('providers.confirm.delete'), tone: 'danger' });
    if (!confirmed) return;
    if (await run(() => deleteProvider(provider.id), t('providers.toast.deleted', { name: provider.name }))) setEditingId(null);
  };

  const takenIds = useMemo(() => providers?.map((provider) => provider.id) ?? [], [providers]);
  const editing = providers?.find((provider) => provider.id === editingId) ?? null;
  const on = providers?.filter((provider) => provider.enabled) ?? [];
  const off = providers?.filter((provider) => !provider.enabled) ?? [];
  const missingKey = on.filter((provider) => !provider.hasKey && provider.authMode !== 'none').length;

  return (
    <>
      <div className="mw-toolbar">
        <span className="mw-caption">{t('providers.toolbar.enabled', { count: on.length })}{missingKey > 0 ? t('providers.toolbar.missing', { count: missingKey }) : ''}{t('providers.toolbar.keychain')}</span>
        <button type="button" className="mw-btn is-primary" onClick={() => { editSession.current++; setAdding('pick'); }}><Plus className="h-4 w-4" />{t('providers.add')}</button>
      </div>
      {loadError && <p className="mw-note is-danger" role="alert">{t('providers.loadFailed', { error: loadError })} <button type="button" className="mw-btn is-ghost" onClick={() => void load()}>{t('providers.retry')}</button></p>}
      {providers && providers.length === 0 && (
        <EmptyState icon={Plug} title={t('empty.providers.title')} description={t('empty.providers.description')}>
          <button type="button" className="mw-btn is-primary" onClick={() => { editSession.current++; setAdding('pick'); }}><Plus className="h-4 w-4" />{t('empty.providers.action')}</button>
        </EmptyState>
      )}
      {on.length > 0 && <ProbeBar settings={healthReport?.probe} onReport={setHealthReport} onNotify={onNotify} />}
      {on.length > 0 && (
        <div className="mw-card mw-rows">
          {on.map((provider) => <ProviderRow key={provider.id} provider={provider} health={health.get(provider.id)} busy={busy || saving} onOpen={() => { editSession.current++; setEditingId(provider.id); }} onToggle={() => toggle(provider)} />)}
        </div>
      )}
      {off.length > 0 && (
        <>
          <button type="button" className="mw-collapse" aria-expanded={showOff} onClick={() => setShowOff((value) => !value)}>
            <ChevronDown className={`h-4 w-4 ${showOff ? '' : 'is-closed'}`} />{t('providers.disabled', { count: off.length })}
          </button>
          {showOff && <div className="mw-card mw-rows">{off.map((provider) => <ProviderRow key={provider.id} provider={provider} busy={busy || saving} onOpen={() => { editSession.current++; setEditingId(provider.id); }} onToggle={() => toggle(provider)} />)}</div>}
        </>
      )}

      {adding && (
        <Sheet
          title={adding === 'pick' ? t('providers.add') : adding.name}
          subtitle={adding === 'pick' ? t('providers.add.subtitle') : adding.custom ? t('providers.add.customSubtitle', { wire: adding.wire === 'anthropic' ? 'Anthropic' : 'OpenAI' }) : hostOf(adding.baseUrl)}
          icon={adding === 'pick' ? <span className="mw-head-icon"><Plus className="h-4 w-4" /></span> : <BrandIcon id={adding.icon} fallback={adding.monogram} size={36} />}
          onClose={() => { editSession.current++; setAdding(null); }}
        >
          {adding === 'pick' ? <PresetPicker onPick={setAdding} /> : (
            <ProviderForm
              key={adding.id}
              target={`new:${adding.id}`}
              isNew
              hasKey={false}
              busy={busy || saving}
              initial={{ id: slugId(adding.custom ? 'custom' : adding.id, takenIds), name: adding.custom ? '' : adding.name, baseUrl: adding.baseUrl, wire: adding.wire, authMode: adding.authMode ?? 'key', models: adding.models.join('\n'), key: '' }}
              onBack={() => { editSession.current++; setAdding('pick'); }}
              onSubmit={(form) => void save(form, null, `new:${adding.id}`)}
            />
          )}
        </Sheet>
      )}

      {editing && (
        <Sheet title={editing.name} subtitle={`${editing.id} · ${hostOf(editing.baseUrl)}`} icon={<ProviderIcon provider={editing} size={36} />} onClose={() => { editSession.current++; setEditingId(null); }}>
          <ProviderForm
            key={editing.id}
            target={`edit:${editing.id}`}
            isNew={false}
            hasKey={editing.hasKey}
            busy={busy || saving}
            initial={{ id: editing.id, name: editing.name, baseUrl: editing.baseUrl, wire: editing.wire, authMode: editing.authMode ?? 'key', models: editing.models.join('\n'), key: '' }}
            onSubmit={(form) => void save(form, editing, `edit:${editing.id}`)}
            onDeleteKey={() => void removeKey(editing)}
          />
          {editing.authMode !== 'none' && <BalanceEntry provider={editing} />}
          <HealthDetail health={health.get(editing.id)} name={editing.name} />
          <footer className="mw-sheet-foot"><button type="button" className="mw-btn is-danger-ghost" disabled={busy || saving} onClick={() => void remove(editing)}>{t('providers.delete')}</button></footer>
        </Sheet>
      )}
    </>
  );
}

export default ProvidersPage;
