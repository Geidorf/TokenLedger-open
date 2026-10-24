import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { CloudDownload, RefreshCw, Save } from 'lucide-react';
import { DisclosurePanel, SettingsActionRow, SettingsCard, SettingsGroup } from './SettingsPrimitives';

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
  return typeof cause === 'string' ? cause : cause instanceof Error ? cause.message : '操作失败，请稍后重试。';
}

/**
 * 「数据与帮助」里的外部网关 WebDAV 同步：读取外部网关放在 WebDAV 上的加密备份，
 * 把选中的供应商（含 API key）导入 TokenLedger 网关。密码与密钥只存系统钥匙串，
 * 本页面只看到“已保存”与否。
 */
export function PeerSyncCard() {
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
    setNote('已保存。密码与同步密码只存在系统钥匙串里。');
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
      ? `${result.keysCleared} 个供应商的接口地址换了主机，原来的 API key 已清除，请重新填写。`
      : '';
    setNote(`已导入 ${result.imported.length} 个供应商，${result.keysSaved} 个 API key 存入系统钥匙串。${cleared}可在「供应商」页查看。`);
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
    <SettingsCard title="外部网关 WebDAV 同步">
      <SettingsGroup>
        <div className="settings-form-grid">
          <label className="settings-field">
            <span>WebDAV 地址</span>
            <input className="settings-input" type="url" value={url} placeholder="https://dav.example.com/dav" onChange={(e) => setUrl(e.target.value)} />
          </label>
          <label className="settings-field">
            <span>用户名</span>
            <input className="settings-input" type="text" value={user} autoComplete="off" onChange={(e) => setUser(e.target.value)} />
          </label>
          <label className="settings-field">
            <span>WebDAV 密码</span>
            <input
              className="settings-input"
              type="password"
              value={password}
              autoComplete="new-password"
              placeholder={config?.hasPassword ? '已保存，留空不变' : ''}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          <label className="settings-field">
            <span>外部网关同步密码</span>
            <input
              className="settings-input"
              type="password"
              value={passphrase}
              autoComplete="new-password"
              placeholder={config?.hasPassphrase ? '已保存，留空不变' : '与外部网关里设置的相同'}
              onChange={(e) => setPassphrase(e.target.value)}
            />
          </label>
        </div>
        {error && <p className="settings-project-note" role="alert">{error}</p>}
        {note && <p className="settings-project-note" role="status">{note}</p>}
        <SettingsActionRow busy={busy !== null}>
          <button className="secondary-inline" type="button" onClick={() => void save()} disabled={busy !== null}>
            <Save className="h-4 w-4" />
            {busy === 'save' ? '保存中…' : '保存'}
          </button>
          <button className="primary-inline" type="button" onClick={() => void readBackup()} disabled={!ready || busy !== null}>
            {busy === 'preview' ? <RefreshCw className="h-4 w-4 animate-spin" /> : <CloudDownload className="h-4 w-4" />}
            {busy === 'preview' ? '读取中…' : '读取外部网关备份'}
          </button>
        </SettingsActionRow>
        {preview && (
          <div className="settings-peer-preview" aria-label="外部网关备份中的供应商">
            {!preview.carriesKeys && (
              <p className="settings-project-note" role="status">这份备份没有带 API key，导入后需要在「供应商」页补填。</p>
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
                        {WIRE_LABEL[p.wire ?? ''] ?? ''} · {p.models} 个模型 · {p.hasKey ? '带 key' : '无 key'}
                        {p.exists ? ' · 将覆盖同名供应商' : ''}
                      </span>
                    )}
                  </label>
                </li>
              ))}
            </ul>
            <SettingsActionRow busy={busy !== null}>
              <button className="primary-inline" type="button" onClick={() => void importPicked()} disabled={picked.size === 0 || busy !== null}>
                {busy === 'import' ? '导入中…' : `导入选中的 ${picked.size} 个供应商`}
              </button>
            </SettingsActionRow>
          </div>
        )}
        <DisclosurePanel title="了解详情：兼容范围与安全">
          <div className="settings-project-copy">
            <ul>
              <li>读取外部网关在 WebDAV 文件夹里的加密备份，用与外部网关相同的同步密码解密（PBKDF2-SHA256 + AES-256-GCM），格式与外部网关完全一致。</li>
              <li>只读取，不改动服务器上的任何文件。</li>
              <li>WebDAV 密码、同步密码和导入的 API key 只存在系统钥匙串里，不写入磁盘文件、不上传云端、不显示在页面上。</li>
              <li>订阅登录（Claude、Codex 等账号）不在外部网关备份里，也不会被读取；只提供 Gemini 原生接口的供应商暂不支持。</li>
            </ul>
          </div>
        </DisclosurePanel>
      </SettingsGroup>
    </SettingsCard>
  );
}
