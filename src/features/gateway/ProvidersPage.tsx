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
import { HealthBadge, HealthDetail, HealthSpark, useProviderHealth } from './ProviderHealth';
import type { ProviderHealth, ProviderRecord, ProviderView, WireApi } from './types';
import { beginProviderSave, clearProviderDraft, endProviderSave, readProviderDraft, useProviderSaving, writeProviderDraft } from './providerDrafts';
import { ProviderIcon, Sheet } from './ui';

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
  if (provider.authMode === 'none') return <span className="mw-chip">无需 key</span>;
  if (provider.hasKey) return <span className="mw-chip is-success">已设置 key</span>;
  return <span className="mw-chip is-warning">未设置 key</span>;
}

const OFFICIAL_BALANCE_HOSTS = new Set(['api.moonshot.cn', 'api.moonshot.ai', 'api.deepseek.com', 'openrouter.ai', 'api.siliconflow.cn', 'api.siliconflow.com']);

export function balanceEntryHint(baseUrl: string): string {
  return OFFICIAL_BALANCE_HOSTS.has(hostOf(baseUrl).toLowerCase())
    ? '可读取官方余额，用这里的 key，在「订阅额度」里开启'
    : '中转站可在「订阅额度」里配置同源余额地址';
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
      <span>余额 · {balanceEntryHint(provider.baseUrl)}</span>
      <button type="button" className="mw-btn is-ghost" onClick={openBalanceSettings} aria-label={`查看 ${provider.name} 余额`}>查看余额</button>
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
          <small>{hostOf(provider.baseUrl)} · {provider.models.length} 个模型 · {WIRE_SHORT[provider.wire] ?? provider.wire}</small>
        </span>
        <span className="mw-row-meta">
          {health && health.stats.requests > 0 && <HealthSpark buckets={health.buckets} label={provider.name} />}
          {provider.enabled && <HealthBadge health={health} />}
          <KeyState provider={provider} />
        </span>
      </button>
      <button type="button" role="switch" aria-checked={provider.enabled} aria-label={`启用 ${provider.name}`} disabled={busy} className={`mw-switch ${provider.enabled ? 'is-on' : ''}`} onClick={onToggle}><span /></button>
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
      <label className="mw-field"><span>名称</span><input value={form.name} onChange={(event) => set({ name: event.target.value })} placeholder="例如：公司中转" required /></label>
      {isNew && <label className="mw-field"><span>ID</span><input value={form.id} onChange={(event) => set({ id: event.target.value })} required /><small>模型写作「ID/模型名」，保存后不能改</small></label>}
      <label className="mw-field"><span>接口地址</span><input value={form.baseUrl} onChange={(event) => set({ baseUrl: event.target.value })} placeholder="https://relay.example.com/v1" required /><small>{form.wire === 'anthropic' ? 'Anthropic 兼容地址，如 https://api.deepseek.com/anthropic 或以 /v1 结尾' : 'OpenAI 兼容地址，通常以 /v1 结尾'}</small></label>
      <label className="mw-field">
        <span>上游协议</span>
        <select className="mw-native-select" value={form.wire} onChange={(event) => set({ wire: event.target.value as WireApi })}>
          {WIRE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
        <small>Chat 上游支持转换基础 Responses 与 Anthropic 请求；无法保真的高级工具或内容会在转发前拒绝。需要完整协议能力时，请选原生 Responses 或 Anthropic 上游。</small>
      </label>
      <label className="mw-field"><span>上游认证</span><select className="mw-native-select" value={form.authMode ?? 'key'} onChange={(event) => set({ authMode: event.target.value as 'key' | 'none' })}><option value="key">API key</option><option value="none">本机免密</option></select><small>免密仅允许 127.0.0.1 或 ::1；远程供应商必须设置 key。</small></label>
      <label className="mw-field"><span>模型</span><textarea rows={3} value={form.models} onChange={(event) => set({ models: event.target.value })} placeholder="每行或用逗号分隔，例如 deepseek-chat" /><small>只有列出的模型会出现在 Agent 与路由组的选择器里</small></label>
      {form.authMode !== 'none' && (
        <label className="mw-field">
          <span>API key {hasKey && <span className="mw-chip is-success">已设置</span>}</span>
          <input type="password" autoComplete="off" value={form.key} onChange={(event) => set({ key: event.target.value })} placeholder={hasKey ? '留空则保持不变' : 'sk-…'} />
          <small>保存在系统钥匙串，只由 TokenLedger 网关读取；界面不会再显示它</small>
        </label>
      )}
      {form.authMode !== 'none' && hasKey && onDeleteKey && (
        <div className="mw-key-row"><KeyRound className="h-4 w-4" aria-hidden="true" /><span>已设置 key</span><button type="button" className="mw-btn is-ghost" disabled={busy} onClick={onDeleteKey}>删除 key</button></div>
      )}
      <div className="mw-form-actions">
        {onBack && <button type="button" className="mw-btn is-ghost" onClick={onBack}>返回</button>}
        <button type="button" className="mw-btn is-ghost" disabled={disabled} onClick={() => { clearProviderDraft(target); setForm({ ...initial, key: '' }); }}>放弃草稿</button>
        <button type="submit" className="mw-btn is-primary" disabled={disabled}>{disabled ? '保存中…' : '保存'}</button>
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
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索供应商或接口地址" aria-label="搜索供应商" />
      </label>
      <div className="mw-preset-groups">
        {groups.map((group) => (
          <section key={group.id}>
            <h3>{group.label}</h3>
            <div className="mw-preset-grid">
              {group.presets.map((preset) => (
                <button key={preset.id} type="button" className="mw-preset" onClick={() => onPick(preset)}>
                  <BrandIcon id={preset.icon} fallback={preset.monogram} size={22} />
                  <span><strong>{preset.name}</strong><small>{preset.keyless ? '本地 · 无需 key' : preset.custom ? '填写接口地址' : hostOf(preset.baseUrl)}</small></span>
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
  const health = useProviderHealth();

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
            throw new Error(`供应商已保存，但 key 未写入：${errorText(error)}`);
          }
          return listProviders();
        }
        return next;
      }, existing ? `${record.name} 已保存` : `${record.name} 已添加`);
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
    const confirmed = await onConfirm({ title: `删除 ${provider.name} 的 key？`, description: '会从系统钥匙串中删除，之后经网关转到这个供应商的请求会失败。', confirmLabel: '删除 key', tone: 'danger' });
    if (confirmed) await run(() => setProviderKey(provider.id, ''), 'key 已删除');
  };

  const remove = async (provider: ProviderView) => {
    const confirmed = await onConfirm({ title: `删除供应商 ${provider.name}？`, description: '同时删除钥匙串里的 key。引用它的路由组成员与 Agent 配置需要另行调整。', confirmLabel: '删除', tone: 'danger' });
    if (!confirmed) return;
    if (await run(() => deleteProvider(provider.id), `${provider.name} 已删除`)) setEditingId(null);
  };

  const takenIds = useMemo(() => providers?.map((provider) => provider.id) ?? [], [providers]);
  const editing = providers?.find((provider) => provider.id === editingId) ?? null;
  const on = providers?.filter((provider) => provider.enabled) ?? [];
  const off = providers?.filter((provider) => !provider.enabled) ?? [];
  const missingKey = on.filter((provider) => !provider.hasKey && provider.authMode !== 'none').length;

  return (
    <>
      <div className="mw-toolbar">
        <span className="mw-caption">{on.length} 个启用{missingKey > 0 ? ` · ${missingKey} 个未设置 key` : ''} · key 存在系统钥匙串，只由网关读取</span>
        <button type="button" className="mw-btn is-primary" onClick={() => { editSession.current++; setAdding('pick'); }}><Plus className="h-4 w-4" />添加供应商</button>
      </div>
      {loadError && <p className="mw-note is-danger" role="alert">读取供应商失败：{loadError} <button type="button" className="mw-btn is-ghost" onClick={() => void load()}>重试</button></p>}
      {providers && providers.length === 0 && (
        <EmptyState icon={Plug} title="还没有供应商" description="选一个预设（OpenAI、DeepSeek、OpenRouter、本机 Ollama 等）或填任意兼容地址，再填入 API key。启用后网关自动启动，模型会出现在 Agent 与路由组的选择器里。">
          <button type="button" className="mw-btn is-primary" onClick={() => { editSession.current++; setAdding('pick'); }}><Plus className="h-4 w-4" />添加第一个供应商</button>
        </EmptyState>
      )}
      {on.length > 0 && (
        <div className="mw-card mw-rows">
          {on.map((provider) => <ProviderRow key={provider.id} provider={provider} health={health.get(provider.id)} busy={busy || saving} onOpen={() => { editSession.current++; setEditingId(provider.id); }} onToggle={() => toggle(provider)} />)}
        </div>
      )}
      {off.length > 0 && (
        <>
          <button type="button" className="mw-collapse" aria-expanded={showOff} onClick={() => setShowOff((value) => !value)}>
            <ChevronDown className={`h-4 w-4 ${showOff ? '' : 'is-closed'}`} />已停用的供应商（{off.length}）
          </button>
          {showOff && <div className="mw-card mw-rows">{off.map((provider) => <ProviderRow key={provider.id} provider={provider} busy={busy || saving} onOpen={() => { editSession.current++; setEditingId(provider.id); }} onToggle={() => toggle(provider)} />)}</div>}
        </>
      )}

      {adding && (
        <Sheet
          title={adding === 'pick' ? '添加供应商' : adding.name}
          subtitle={adding === 'pick' ? '选一个预设，贴上 key 就能用' : adding.custom ? `填写 ${adding.wire === 'anthropic' ? 'Anthropic' : 'OpenAI'} 兼容接口地址` : hostOf(adding.baseUrl)}
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
          <footer className="mw-sheet-foot"><button type="button" className="mw-btn is-danger-ghost" disabled={busy || saving} onClick={() => void remove(editing)}>删除供应商</button></footer>
        </Sheet>
      )}
    </>
  );
}

export default ProvidersPage;
