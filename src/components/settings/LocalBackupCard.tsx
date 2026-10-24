import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Archive, FolderSearch, LogOut, RefreshCw, RotateCcw, Save, ShieldCheck } from 'lucide-react';
import { useT, type MessageKey } from '../../i18n';
import { formatNum } from '../../utils/format';
import { DisclosurePanel, SettingsActionRow, SettingsCard, SettingsGroup } from './SettingsPrimitives';

export interface LocalBackupAutoView {
  enabled: boolean;
  dir: string;
  intervalHours: number;
  keep: number;
  lastRunAt: string | null;
  lastFile: string | null;
  lastError: string | null;
  hasPassphrase: boolean;
  nextDue: string | null;
}

export interface LocalBackupStatus {
  defaultDir: string;
  auto: LocalBackupAutoView;
}

export interface LocalBackupFile {
  path: string;
  name: string;
  bytes: number;
  modified: string;
}

export interface LocalBackupExportResult {
  path: string;
  bytes: number;
  ledgerRows: number;
  gatewayRequests: number;
  providers: number;
  routingGroups: number;
}

export type LocalBackupItemStatus = 'new' | 'same' | 'differs';

export interface LocalBackupItemDiff {
  id: string;
  name: string;
  status: LocalBackupItemStatus;
}

export interface LocalBackupRowCounts {
  total: number;
  new: number;
  known: number;
  /** 另一台电脑还没上传云端的行：照常恢复，但本机上传时可能覆盖那台电脑之后上传的同小时总量。 */
  otherComputerPending: number;
  first: string | null;
  last: string | null;
}

export interface LocalBackupPreview {
  /** 预览读到的那份文件的摘要；恢复时交回，文件被换就拒绝恢复。 */
  digest: string;
  created: string;
  appVersion: string;
  machine: string;
  sameMachine: boolean;
  ledger: LocalBackupRowCounts;
  /** 网关请求只恢复到产生它们的那台电脑，否则会被当成本机用量重复上传云端。 */
  gatewayRequestsRestorable: boolean;
  gatewayRequests: LocalBackupRowCounts;
  providers: LocalBackupItemDiff[];
  providersWithoutKey: string[];
  routingGroups: LocalBackupItemDiff[];
  budgets: LocalBackupItemDiff[];
  settings: LocalBackupItemStatus | null;
  prices: LocalBackupItemStatus | null;
  quotaAlerts: LocalBackupItemStatus | null;
}

export interface LocalBackupApplyResult {
  snapshot: string;
  ledgerAdded: number;
  gatewayAdded: number;
  providersAdded: number;
  providersReplaced: number;
  providersNeedKey: string[];
  groupsAdded: number;
  groupsReplaced: number;
  groupsSkipped: string[];
  budgetsAdded: number;
  budgetsReplaced: number;
  settingsRestored: boolean;
  pricesRestored: boolean;
  quotaAlertsRestored: boolean;
  restartSuggested: boolean;
}

type SectionKey = 'ledger' | 'gatewayRequests' | 'providers' | 'routingGroups' | 'budgets' | 'settings' | 'prices' | 'quotaAlerts';
type Sections = Record<SectionKey, boolean>;
type Conflict = 'keepLocal' | 'useBackup';
type Busy = 'export' | 'list' | 'preview' | 'apply' | 'saveAuto' | 'runAuto' | 'quit';

const SECTION_ORDER: SectionKey[] = ['ledger', 'gatewayRequests', 'providers', 'routingGroups', 'budgets', 'settings', 'prices', 'quotaAlerts'];
const SECTION_LABEL: Record<SectionKey, MessageKey> = {
  ledger: 'backup.section.ledger',
  gatewayRequests: 'backup.section.gatewayRequests',
  providers: 'backup.section.providers',
  routingGroups: 'backup.section.routingGroups',
  budgets: 'backup.section.budgets',
  settings: 'backup.section.settings',
  prices: 'backup.section.prices',
  quotaAlerts: 'backup.section.quotaAlerts',
};
const STATUS_LABEL: Record<LocalBackupItemStatus, MessageKey> = {
  new: 'backup.status.new',
  same: 'backup.status.same',
  differs: 'backup.status.differs',
};
const INTERVALS: { hours: number; label: MessageKey }[] = [
  { hours: 24, label: 'backup.auto.daily' },
  { hours: 72, label: 'backup.auto.every3Days' },
  { hours: 168, label: 'backup.auto.weekly' },
];
export const MIN_PASSPHRASE = 8;

function errorText(cause: unknown, fallback: string) {
  return typeof cause === 'string' ? cause : cause instanceof Error ? cause.message : fallback;
}

function prettyBytes(bytes: number) {
  return bytes >= 1_048_576 ? `${(bytes / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function shortTime(value: string | null) {
  if (!value) return '—';
  const at = new Date(value.includes('T') ? value : value.replace(' ', 'T'));
  return Number.isNaN(at.getTime()) ? value : at.toLocaleString();
}

/** 每块里“有东西可恢复”时默认勾上；全都一样的块默认不勾。 */
export function defaultSections(preview: LocalBackupPreview): Sections {
  const changed = (items: LocalBackupItemDiff[]) => items.some((item) => item.status !== 'same');
  const differs = (status: LocalBackupItemStatus | null) => status !== null && status !== 'same';
  return {
    ledger: preview.ledger.new > 0,
    gatewayRequests: preview.gatewayRequestsRestorable && preview.gatewayRequests.new > 0,
    providers: changed(preview.providers),
    routingGroups: changed(preview.routingGroups),
    budgets: changed(preview.budgets),
    settings: differs(preview.settings),
    prices: differs(preview.prices),
    quotaAlerts: differs(preview.quotaAlerts),
  };
}

/**
 * 「数据与帮助」里的本机备份与迁移：把账本、设置、路由组、预算等导出成一个加密文件，
 * 在新电脑上预览后去重合并恢复；可选定期自动备份到本地文件夹。API key 等密钥不进备份。
 */
export function LocalBackupCard() {
  const t = useT();
  const [status, setStatus] = useState<LocalBackupStatus | null>(null);
  const [dir, setDir] = useState('');
  const [exportPass, setExportPass] = useState('');
  const [exportConfirm, setExportConfirm] = useState('');
  const [files, setFiles] = useState<LocalBackupFile[] | null>(null);
  const [path, setPath] = useState('');
  const [restorePass, setRestorePass] = useState('');
  const [preview, setPreview] = useState<LocalBackupPreview | null>(null);
  const [sections, setSections] = useState<Sections | null>(null);
  const [conflict, setConflict] = useState<Conflict>('keepLocal');
  const [result, setResult] = useState<LocalBackupApplyResult | null>(null);
  const [autoEnabled, setAutoEnabled] = useState(false);
  const [autoDir, setAutoDir] = useState('');
  const [autoInterval, setAutoInterval] = useState(24);
  const [autoKeep, setAutoKeep] = useState(7);
  const [autoPass, setAutoPass] = useState('');
  const [busy, setBusy] = useState<Busy | null>(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');

  const applyAuto = (auto: LocalBackupAutoView) => {
    setAutoEnabled(auto.enabled);
    setAutoDir(auto.dir);
    setAutoInterval(auto.intervalHours);
    setAutoKeep(auto.keep);
  };

  const refresh = useCallback(async () => {
    try {
      const next = await invoke<LocalBackupStatus | null>('local_backup_status');
      if (!next?.auto) return;
      setStatus(next);
      setDir((current) => current || next.auto.dir || next.defaultDir);
      applyAuto(next.auto);
    } catch (cause) {
      setError(errorText(cause, ''));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = async <T,>(action: Busy, task: () => Promise<T>) => {
    if (busy) return undefined;
    setBusy(action);
    setError('');
    setNote('');
    try {
      return await task();
    } catch (cause) {
      setError(errorText(cause, t('backup.error.generic')));
      return undefined;
    } finally {
      setBusy(null);
    }
  };

  const exportReady = exportPass.length >= MIN_PASSPHRASE && exportPass === exportConfirm && dir.trim() !== '';
  const doExport = () => run('export', async () => {
    const done = await invoke<LocalBackupExportResult>('local_backup_export', { input: { dir, passphrase: exportPass } });
    setExportPass('');
    setExportConfirm('');
    setNote(t('backup.export.done', { path: done.path, size: prettyBytes(done.bytes), rows: formatNum(done.ledgerRows) }));
  });

  const listFiles = () => run('list', async () => {
    setFiles(await invoke<LocalBackupFile[]>('local_backup_list', { dir }));
  });

  const pickFile = (next: string) => {
    setPath(next);
    setPreview(null);
    setSections(null);
    setResult(null);
  };

  const doPreview = () => run('preview', async () => {
    const next = await invoke<LocalBackupPreview>('local_backup_preview', { input: { path, passphrase: restorePass } });
    setPreview(next);
    setSections(defaultSections(next));
    setResult(null);
  });

  const doApply = () => run('apply', async () => {
    if (!preview || !sections) return;
    const done = await invoke<LocalBackupApplyResult>('local_backup_apply', {
      input: { path, passphrase: restorePass, digest: preview.digest, sections, conflict },
    });
    setResult(done);
    setPreview(null);
    setSections(null);
    setRestorePass('');
  });

  const saveAuto = () => run('saveAuto', async () => {
    const view = await invoke<LocalBackupAutoView>('local_backup_save_auto', {
      input: {
        enabled: autoEnabled,
        dir: autoDir,
        intervalHours: autoInterval,
        keep: autoKeep,
        ...(autoPass ? { passphrase: autoPass } : {}),
      },
    });
    setAutoPass('');
    applyAuto(view);
    setStatus((current) => (current ? { ...current, auto: view } : current));
    setNote(t('backup.auto.saved'));
  });

  const runAuto = () => run('runAuto', async () => {
    const view = await invoke<LocalBackupAutoView>('local_backup_run_auto_now');
    applyAuto(view);
    setStatus((current) => (current ? { ...current, auto: view } : current));
    setNote(view.lastError ? '' : t('backup.auto.ranNow', { path: view.lastFile ?? '' }));
    if (view.lastError) setError(view.lastError);
  });

  const quit = () => run('quit', async () => {
    await invoke('local_backup_quit');
  });

  const toggleSection = (key: SectionKey) => {
    setSections((current) => (current ? { ...current, [key]: !current[key] } : current));
  };

  const statusLabel = (value: LocalBackupItemStatus) => t(STATUS_LABEL[value]);
  const itemSummary = (items: LocalBackupItemDiff[]) => {
    if (items.length === 0) return t('backup.preview.none');
    const count = (value: LocalBackupItemStatus) => items.filter((item) => item.status === value).length;
    return t('backup.preview.items', { total: items.length, added: count('new'), differs: count('differs') });
  };
  const sectionDetail = (key: SectionKey): string => {
    if (!preview) return '';
    switch (key) {
      case 'ledger':
      case 'gatewayRequests': {
        const counts = preview[key];
        if (key === 'gatewayRequests' && counts.total > 0 && !preview.gatewayRequestsRestorable) {
          return t('backup.preview.gatewayOtherMachine');
        }
        if (counts.total === 0) return t('backup.preview.none');
        const rows = t('backup.preview.rows', { total: formatNum(counts.total), added: formatNum(counts.new), known: formatNum(counts.known) });
        return counts.otherComputerPending > 0
          ? `${rows}${t('backup.preview.otherComputerPending', { count: formatNum(counts.otherComputerPending) })}`
          : rows;
      }
      case 'providers':
      case 'routingGroups':
      case 'budgets':
        return itemSummary(preview[key]);
      default: {
        const value = preview[key];
        return value === null ? t('backup.preview.none') : statusLabel(value);
      }
    }
  };
  const sectionAvailable = (key: SectionKey) => {
    if (!preview) return false;
    switch (key) {
      case 'ledger':
        return preview.ledger.total > 0;
      case 'gatewayRequests':
        return preview.gatewayRequestsRestorable && preview.gatewayRequests.total > 0;
      case 'providers':
      case 'routingGroups':
      case 'budgets':
        return preview[key].length > 0;
      default:
        return preview[key] !== null;
    }
  };

  const anyPicked = sections !== null && SECTION_ORDER.some((key) => sections[key]);
  const auto = status?.auto;
  return (
    <SettingsCard title={t('backup.title')} description={t('backup.description')}>
      <SettingsGroup>
        <p className="settings-project-note">{t('backup.export.heading')}</p>
        <div className="settings-form-grid">
          <label className="settings-field">
            <span>{t('backup.field.dir')}</span>
            <input className="settings-input" type="text" value={dir} spellCheck={false} onChange={(e) => setDir(e.target.value)} />
          </label>
          <label className="settings-field">
            <span>{t('backup.field.passphrase')}</span>
            <input
              className="settings-input"
              type="password"
              value={exportPass}
              autoComplete="new-password"
              placeholder={t('backup.field.passphraseHint', { n: MIN_PASSPHRASE })}
              onChange={(e) => setExportPass(e.target.value)}
            />
          </label>
          <label className="settings-field">
            <span>{t('backup.field.confirm')}</span>
            <input className="settings-input" type="password" value={exportConfirm} autoComplete="new-password" onChange={(e) => setExportConfirm(e.target.value)} />
          </label>
        </div>
        {exportConfirm !== '' && exportConfirm !== exportPass && (
          <p className="settings-project-note" role="status">{t('backup.export.mismatch')}</p>
        )}
        <SettingsActionRow busy={busy !== null}>
          <button className="primary-inline" type="button" onClick={() => void doExport()} disabled={!exportReady || busy !== null}>
            {busy === 'export' ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Archive className="h-4 w-4" />}
            {busy === 'export' ? t('backup.export.busy') : t('backup.export.action')}
          </button>
        </SettingsActionRow>
      </SettingsGroup>

      <SettingsGroup>
        <p className="settings-project-note">{t('backup.restore.heading')}</p>
        <div className="settings-form-grid">
          <label className="settings-field">
            <span>{t('backup.field.file')}</span>
            <input
              className="settings-input"
              type="text"
              value={path}
              spellCheck={false}
              placeholder={t('backup.field.fileHint')}
              onChange={(e) => pickFile(e.target.value)}
            />
          </label>
          <label className="settings-field">
            <span>{t('backup.field.passphrase')}</span>
            <input className="settings-input" type="password" value={restorePass} autoComplete="current-password" onChange={(e) => setRestorePass(e.target.value)} />
          </label>
        </div>
        {files !== null && (
          files.length === 0 ? (
            <p className="settings-project-note" role="status">{t('backup.restore.noFiles')}</p>
          ) : (
            <ul className="settings-peer-list" aria-label={t('backup.restore.filesLabel')}>
              {files.map((file) => (
                <li key={file.path}>
                  <label>
                    <input type="radio" name="local-backup-file" checked={path === file.path} onChange={() => pickFile(file.path)} />
                    <span className="settings-peer-name">{file.name}</span>
                    <span className="settings-peer-meta">{prettyBytes(file.bytes)} · {shortTime(file.modified)}</span>
                  </label>
                </li>
              ))}
            </ul>
          )
        )}
        <SettingsActionRow busy={busy !== null}>
          <button className="secondary-inline" type="button" onClick={() => void listFiles()} disabled={dir.trim() === '' || busy !== null}>
            <FolderSearch className="h-4 w-4" />
            {t('backup.restore.list')}
          </button>
          <button className="primary-inline" type="button" onClick={() => void doPreview()} disabled={path.trim() === '' || restorePass === '' || busy !== null}>
            {busy === 'preview' ? <RefreshCw className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
            {busy === 'preview' ? t('backup.restore.previewBusy') : t('backup.restore.preview')}
          </button>
        </SettingsActionRow>

        {preview && sections && (
          <div className="settings-peer-preview" aria-label={t('backup.preview.label')}>
            <p className="settings-project-note">
              {t('backup.preview.source', { created: shortTime(preview.created), version: preview.appVersion })}
              {preview.sameMachine ? t('backup.preview.sameMachine') : t('backup.preview.otherMachine')}
            </p>
            <ul className="settings-peer-list">
              {SECTION_ORDER.map((key) => (
                <li key={key}>
                  <label>
                    <input type="checkbox" checked={sections[key]} disabled={!sectionAvailable(key)} onChange={() => toggleSection(key)} />
                    <span className="settings-peer-name">{t(SECTION_LABEL[key])}</span>
                    <span className="settings-peer-meta">{sectionDetail(key)}</span>
                  </label>
                </li>
              ))}
            </ul>
            {preview.providersWithoutKey.length > 0 && (
              <p className="settings-project-note" role="status">
                {t('backup.preview.needKeys', { ids: preview.providersWithoutKey.join(', ') })}
              </p>
            )}
            <div className="settings-form-grid" role="radiogroup" aria-label={t('backup.conflict.label')}>
              <label className="settings-peer-meta">
                <input type="radio" name="local-backup-conflict" checked={conflict === 'keepLocal'} onChange={() => setConflict('keepLocal')} />{' '}
                {t('backup.conflict.keepLocal')}
              </label>
              <label className="settings-peer-meta">
                <input type="radio" name="local-backup-conflict" checked={conflict === 'useBackup'} onChange={() => setConflict('useBackup')} />{' '}
                {t('backup.conflict.useBackup')}
              </label>
            </div>
            <SettingsActionRow busy={busy !== null}>
              <button className="primary-inline" type="button" onClick={() => void doApply()} disabled={!anyPicked || busy !== null}>
                {busy === 'apply' ? <RefreshCw className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
                {busy === 'apply' ? t('backup.restore.applyBusy') : t('backup.restore.apply')}
              </button>
            </SettingsActionRow>
          </div>
        )}

        {result && (
          <div className="settings-peer-preview" role="status" aria-label={t('backup.result.label')}>
            <p className="settings-project-note">
              {t('backup.result.summary', {
                rows: formatNum(result.ledgerAdded),
                requests: formatNum(result.gatewayAdded),
                providers: result.providersAdded + result.providersReplaced,
                groups: result.groupsAdded + result.groupsReplaced,
                budgets: result.budgetsAdded + result.budgetsReplaced,
              })}
            </p>
            {result.providersNeedKey.length > 0 && (
              <p className="settings-project-note">{t('backup.result.needKeys', { ids: result.providersNeedKey.join(', ') })}</p>
            )}
            {result.groupsSkipped.length > 0 && (
              <p className="settings-project-note">{t('backup.result.groupsSkipped', { list: result.groupsSkipped.join('; ') })}</p>
            )}
            <p className="settings-project-note">{t('backup.result.snapshot', { path: result.snapshot })}</p>
            {result.restartSuggested && (
              <SettingsActionRow busy={busy !== null}>
                <span className="settings-peer-meta">{t('backup.result.restart')}</span>
                <button className="secondary-inline" type="button" onClick={() => void quit()} disabled={busy !== null}>
                  <LogOut className="h-4 w-4" />
                  {t('backup.quit')}
                </button>
              </SettingsActionRow>
            )}
          </div>
        )}
      </SettingsGroup>

      <SettingsGroup>
        <p className="settings-project-note">{t('backup.auto.heading')}</p>
        <div className="settings-form-grid">
          <label className="settings-field">
            <span>{t('backup.auto.enabled')}</span>
            <select className="settings-input" value={autoEnabled ? 'on' : 'off'} onChange={(e) => setAutoEnabled(e.target.value === 'on')}>
              <option value="off">{t('backup.auto.off')}</option>
              <option value="on">{t('backup.auto.on')}</option>
            </select>
          </label>
          <label className="settings-field">
            <span>{t('backup.auto.interval')}</span>
            <select className="settings-input" value={autoInterval} onChange={(e) => setAutoInterval(Number(e.target.value))}>
              {INTERVALS.map((option) => (
                <option key={option.hours} value={option.hours}>{t(option.label)}</option>
              ))}
            </select>
          </label>
          <label className="settings-field">
            <span>{t('backup.auto.keep')}</span>
            <input className="settings-input" type="number" min={1} max={60} value={autoKeep} onChange={(e) => setAutoKeep(Math.max(1, Math.min(60, Number(e.target.value) || 1)))} />
          </label>
          <label className="settings-field">
            <span>{t('backup.field.dir')}</span>
            <input className="settings-input" type="text" value={autoDir} spellCheck={false} onChange={(e) => setAutoDir(e.target.value)} />
          </label>
          <label className="settings-field">
            <span>{t('backup.auto.passphrase')}</span>
            <input
              className="settings-input"
              type="password"
              value={autoPass}
              autoComplete="new-password"
              placeholder={auto?.hasPassphrase ? t('backup.auto.passphraseSaved') : t('backup.field.passphraseHint', { n: MIN_PASSPHRASE })}
              onChange={(e) => setAutoPass(e.target.value)}
            />
          </label>
        </div>
        {auto && (auto.lastRunAt || auto.nextDue) && (
          <p className="settings-project-note" role="status">
            {auto.lastRunAt && (auto.lastError
              ? t('backup.auto.lastFailed', { at: shortTime(auto.lastRunAt), error: auto.lastError })
              : t('backup.auto.lastOk', { at: shortTime(auto.lastRunAt) }))}
            {auto.nextDue && ` ${t('backup.auto.next', { at: shortTime(auto.nextDue) })}`}
          </p>
        )}
        <SettingsActionRow busy={busy !== null}>
          <button className="secondary-inline" type="button" onClick={() => void saveAuto()} disabled={autoDir.trim() === '' || busy !== null}>
            <Save className="h-4 w-4" />
            {busy === 'saveAuto' ? t('backup.saving') : t('backup.auto.save')}
          </button>
          <button className="secondary-inline" type="button" onClick={() => void runAuto()} disabled={!auto?.hasPassphrase || busy !== null}>
            {busy === 'runAuto' ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Archive className="h-4 w-4" />}
            {t('backup.auto.runNow')}
          </button>
        </SettingsActionRow>

        {error && <p className="settings-project-note" role="alert">{error}</p>}
        {note && <p className="settings-project-note" role="status">{note}</p>}

        <DisclosurePanel title={t('backup.details.title')}>
          <div className="settings-project-copy">
            <ul>
              <li>{t('backup.details.contents')}</li>
              <li>{t('backup.details.secrets')}</li>
              <li>{t('backup.details.merge')}</li>
              <li>{t('backup.details.snapshot')}</li>
              <li>{t('backup.details.crypto')}</li>
            </ul>
          </div>
        </DisclosurePanel>
      </SettingsGroup>
    </SettingsCard>
  );
}
