import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { CloudDownload, CloudUpload, RefreshCw, Save } from 'lucide-react';
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
}

export interface PeerSyncImportResult {
  imported: string[];
  keysSaved: number;
  skipped: string[];
}

export interface PeerExportCandidate {
  id: string;
  name: string;
  peerId: string;
  update: boolean;
  unsupported: string | null;
}

export interface PeerExportPreview {
  providers: PeerExportCandidate[];
}

export interface PeerExportResult {
  added: string[];
  updated: string[];
  skipped: string[];
  savedAs: string;
}

const WIRE_LABEL: Record<string, string> = { chat: 'Chat', responses: 'Responses', anthropic: 'Anthropic' };

type Busy = 'save' | 'preview' | 'import' | 'exportPreview' | 'export';

function errorText(cause: unknown) {
  return typeof cause === 'string' ? cause : cause instanceof Error ? cause.message : '操作失败，请稍后重试。';
}

/**
 * 「数据与帮助」里的外部网关 WebDAV 同步：读取外部网关放在 WebDAV 上的加密备份，
 * 把选中的供应商（含 API key）导入 TokenLedger 网关；也可把 TokenLedger 的供应商
 * （不含 key）写回外部网关备份。密码与密钥只存系统钥匙串，本页面只看到“已保存”与否。
 */
export function PeerSyncCard() {
  const [config, setConfig] = useState<PeerSyncConfig | null>(null);
  const [url, setUrl] = useState('');
  const [user, setUser] = useState('');
  const [password, setPassword] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [preview, setPreview] = useState<PeerSyncPreview | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [exportPlan, setExportPlan] = useState<PeerExportPreview | null>(null);
  const [exportPicked, setExportPicked] = useState<Set<string>>(new Set());
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
    setPassword('');
    setPassphrase('');
    setNote('已保存。密码与同步密码只存在系统钥匙串里。');
  });

  const readBackup = () => run('preview', async () => {
    const next = await invoke<PeerSyncPreview>('peer_sync_preview');
    setExportPlan(null);
    setPreview(next);
    setPicked(new Set(next.providers.filter((p) => !p.unsupported).map((p) => p.peerId)));
  });

  const importPicked = () => run('import', async () => {
    const result = await invoke<PeerSyncImportResult>('peer_sync_import_providers', { peerIds: [...picked] });
    setNote(`已导入 ${result.imported.length} 个供应商，${result.keysSaved} 个 API key 存入系统钥匙串。可在「供应商」页查看。`);
    setPreview(null);
  });

  const readExport = () => run('exportPreview', async () => {
    const next = await invoke<PeerExportPreview>('peer_sync_export_preview');
    setPreview(null);
    setExportPlan(next);
    setExportPicked(new Set());
  });

  const writeExport = () => run('export', async () => {
    const result = await invoke<PeerExportResult>('peer_sync_export_providers', { ids: [...exportPicked] });
    setNote(
      `已写入外部网关备份：新增 ${result.added.length} 个、更新 ${result.updated.length} 个供应商。`
      + `服务器原文件已保存为 ${result.savedAs}。其他电脑上的外部网关会在下次同步时带入。`,
    );
    setExportPlan(null);
  });

  const flip = (set: (update: (current: Set<string>) => Set<string>) => void) => (id: string) => {
    set((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const toggle = flip(setPicked);
  const toggleExport = flip(setExportPicked);

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
          <button className="secondary-inline" type="button" onClick={() => void readExport()} disabled={!ready || busy !== null}>
            {busy === 'exportPreview' ? <RefreshCw className="h-4 w-4 animate-spin" /> : <CloudUpload className="h-4 w-4" />}
            {busy === 'exportPreview' ? '读取中…' : '写入外部网关…'}
          </button>
        </SettingsActionRow>
        {exportPlan && (
          <div className="settings-peer-preview" aria-label="写入外部网关备份的供应商">
            <p className="settings-project-note" role="status">
              选中的供应商会写进外部网关的 WebDAV 备份，所有电脑上的外部网关都会在下次同步时带入。
              只新增或更新，不删除外部网关里的任何供应商；API key 不会写出，新增的供应商需要在外部网关里补填 key。
            </p>
            <ul className="settings-peer-list">
              {exportPlan.providers.map((p) => (
                <li key={p.id}>
                  <label>
                    <input
                      type="checkbox"
                      checked={exportPicked.has(p.id)}
                      disabled={Boolean(p.unsupported)}
                      onChange={() => toggleExport(p.id)}
                    />
                    <span className="settings-peer-name">{p.name || p.id}</span>
                    <span className="settings-peer-meta">
                      {p.unsupported ?? (p.update ? `更新外部网关的「${p.peerId}」` : '新增到外部网关')}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
            <SettingsActionRow busy={busy !== null}>
              <button className="primary-inline" type="button" onClick={() => void writeExport()} disabled={exportPicked.size === 0 || busy !== null}>
                {busy === 'export' ? '写入中…' : `写入选中的 ${exportPicked.size} 个供应商`}
              </button>
              <button className="secondary-inline" type="button" onClick={() => setExportPlan(null)} disabled={busy !== null}>
                取消
              </button>
            </SettingsActionRow>
          </div>
        )}
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
              <li>读取不改动服务器。只有点「写入外部网关」并确认后才写：只新增或更新选中的供应商，外部网关的其他设置、供应商和账号原样保留；写之前会把服务器原文件保存在本机，可用外部网关的「恢复」放回。</li>
              <li>写入时按外部网关的方式检查版本（ETag），如果另一台电脑刚同步过，会停下让你重新读取，不会覆盖它的改动。</li>
              <li>WebDAV 密码、同步密码和导入的 API key 只存在系统钥匙串里，不写入磁盘文件、不上传云端、不显示在页面上。写入外部网关时也不带出任何 API key。</li>
              <li>订阅登录（Claude、Codex 等账号）不在外部网关备份里，也不会被读取；只提供 Gemini 原生接口的供应商暂不支持。</li>
            </ul>
          </div>
        </DisclosurePanel>
      </SettingsGroup>
    </SettingsCard>
  );
}
