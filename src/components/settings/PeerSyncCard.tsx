import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { CloudDownload, RefreshCw, Save } from 'lucide-react';
import { DisclosurePanel, SettingsActionRow, SettingsCard, SettingsGroup } from './SettingsPrimitives';
import { t, useLang } from '../../i18n';

export interface PeerSyncConfig {
  url: string;
  user: string;
  hasPassword: boolean;
  hasPassphrase: boolean;
}

export interface PeerSyncCandidate {
  peerId: string;
  id: string;
  name: string;
  baseUrl: string;
  wire: 'chat' | 'responses' | 'anthropic' | null;
  models: number;
  hasKey: boolean;
  enabled: boolean;
  exists: boolean;
  unsupported: string | null;
}

export interface PeerSyncPreview {
  created: string;
  app: string;
  carriesKeys: boolean;
  providers: PeerSyncCandidate[];
  /** 预览读到的那份备份的摘要；导入时交回，服务器换了备份就拒绝导入。 */
  digest: string;
}

export interface PeerSyncImportResult {
  imported: string[];
  keysSaved: number;
  /** 接口地址换了主机的已有供应商，旧 key 被清掉、需要重新填写的个数。 */
  keysCleared?: number;
  skipped: string[];
}

const WIRE_LABEL: Record<string, string> = { chat: 'Chat', responses: 'Responses', anthropic: 'Anthropic' };

type Busy = 'save' | 'preview' | 'import';

function errorText(cause: unknown) {
  return typeof cause === 'string' ? cause : cause instanceof Error ? cause.message : t('peerSync.error');
}

/**
 * 「数据与帮助」里的外部网关 WebDAV 同步：读取外部网关放在 WebDAV 上的加密备份，
 * 把选中的供应商（含 API key）导入 TokenLedger 网关。密码与密钥只存系统钥匙串，
 * 本页面只看到“已保存”与否。
 */
export function PeerSyncCard() {
  useLang();
  const [config, setConfig] = useState<PeerSyncConfig | null>(null);
  const [url, setUrl] = useState('');
  const [user, setUser] = useState('');
  const [password, setPassword] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [preview, setPreview] = useState<PeerSyncPreview | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<Busy | null>(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');

  const apply = (next: PeerSyncConfig) => {
    setConfig(next);
    setUrl(next.url);
    setUser(next.user);
  };

  const refresh = useCallback(async () => {
    try {
      apply(await invoke<PeerSyncConfig>('peer_sync_get_config'));
    } catch (cause) {
      setError(errorText(cause));
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
      setError(errorText(cause));
      return undefined;
    } finally {
      setBusy(null);
    }
  };

  const save = () => run('save', async () => {
    const next = await invoke<PeerSyncConfig>('peer_sync_save_config', {
      input: {
        url,
        user,
        ...(password ? { password } : {}),
        ...(passphrase ? { passphrase } : {}),
      },
    });
    apply(next);
    // 旧预览来自之前的地址或密码，导入会按新设置重新下载，必须重新读取。
    setPreview(null);
    setPicked(new Set());
    setPassword('');
    setPassphrase('');
    setNote(t('peerSync.saved'));
  });

  const readBackup = () => run('preview', async () => {
    const next = await invoke<PeerSyncPreview>('peer_sync_preview');
    setPreview(next);
    setPicked(new Set(next.providers.filter((p) => !p.unsupported).map((p) => p.peerId)));
  });

  const importPicked = () => run('import', async () => {
    if (!preview) return;
    const result = await invoke<PeerSyncImportResult>('peer_sync_import_providers', {
      peerIds: [...picked],
      digest: preview.digest,
    });
    const cleared = result.keysCleared
      ? t('peerSync.keysCleared', { count: result.keysCleared })
      : '';
    setNote(t('peerSync.imported', { count: result.imported.length, keys: result.keysSaved, cleared }));
    setPreview(null);
  });

  const toggle = (id: string) => {
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const ready = Boolean(config?.url) && config?.hasPassphrase === true;
  return (
    <SettingsCard title={t('peerSync.title')}>
      <SettingsGroup>
        <div className="settings-form-grid">
          <label className="settings-field">
            <span>{t('peerSync.url')}</span>
            <input className="settings-input" type="url" value={url} placeholder="https://dav.example.com/dav" onChange={(e) => setUrl(e.target.value)} />
          </label>
          <label className="settings-field">
            <span>{t('peerSync.user')}</span>
            <input className="settings-input" type="text" value={user} autoComplete="off" onChange={(e) => setUser(e.target.value)} />
          </label>
          <label className="settings-field">
            <span>{t('peerSync.password')}</span>
            <input
              className="settings-input"
              type="password"
              value={password}
              autoComplete="new-password"
              placeholder={config?.hasPassword ? t('peerSync.savedPlaceholder') : ''}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          <label className="settings-field">
            <span>{t('peerSync.passphrase')}</span>
            <input
              className="settings-input"
              type="password"
              value={passphrase}
              autoComplete="new-password"
              placeholder={config?.hasPassphrase ? t('peerSync.savedPlaceholder') : t('peerSync.passphrasePlaceholder')}
              onChange={(e) => setPassphrase(e.target.value)}
            />
          </label>
        </div>
        {error && <p className="settings-project-note" role="alert">{error}</p>}
        {note && <p className="settings-project-note" role="status">{note}</p>}
        <SettingsActionRow busy={busy !== null}>
          <button className="secondary-inline" type="button" onClick={() => void save()} disabled={busy !== null}>
            <Save className="h-4 w-4" />
            {busy === 'save' ? t('peerSync.saving') : t('peerSync.save')}
          </button>
          <button className="primary-inline" type="button" onClick={() => void readBackup()} disabled={!ready || busy !== null}>
            {busy === 'preview' ? <RefreshCw className="h-4 w-4 animate-spin" /> : <CloudDownload className="h-4 w-4" />}
            {busy === 'preview' ? t('peerSync.reading') : t('peerSync.read')}
          </button>
        </SettingsActionRow>
        {preview && (
          <div className="settings-peer-preview" aria-label={t('peerSync.previewAria')}>
            {!preview.carriesKeys && (
              <p className="settings-project-note" role="status">{t('peerSync.noKeys')}</p>
            )}
            <ul className="settings-peer-list">
              {preview.providers.map((p) => (
                <li key={p.peerId}>
                  <label>
                    <input
                      type="checkbox"
                      checked={picked.has(p.peerId)}
                      disabled={Boolean(p.unsupported)}
                      onChange={() => toggle(p.peerId)}
                    />
                    <span className="settings-peer-name">{p.name || p.peerId}</span>
                    {p.unsupported ? (
                      <span className="settings-peer-meta">{p.unsupported}</span>
                    ) : (
                      <span className="settings-peer-meta">
                        {WIRE_LABEL[p.wire ?? ''] ?? ''} · {t('peerSync.models', { count: p.models })} · {p.hasKey ? t('peerSync.hasKey') : t('peerSync.noKey')}
                        {p.exists ? t('peerSync.overwrite') : ''}
                      </span>
                    )}
                  </label>
                </li>
              ))}
            </ul>
            <SettingsActionRow busy={busy !== null}>
              <button className="primary-inline" type="button" onClick={() => void importPicked()} disabled={picked.size === 0 || busy !== null}>
                {busy === 'import' ? t('peerSync.importing') : t('peerSync.import', { count: picked.size })}
              </button>
            </SettingsActionRow>
          </div>
        )}
        <DisclosurePanel title={t('peerSync.details')}>
          <div className="settings-project-copy">
            <ul>
              <li>{t('peerSync.detail1')}</li>
              <li>{t('peerSync.detail2')}</li>
              <li>{t('peerSync.detail3')}</li>
              <li>{t('peerSync.detail4')}</li>
            </ul>
          </div>
        </DisclosurePanel>
      </SettingsGroup>
    </SettingsCard>
  );
}
