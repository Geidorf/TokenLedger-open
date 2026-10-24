import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Monitor, RefreshCw, Trash2 } from 'lucide-react';
import { DisclosurePanel, SettingsActionRow, SettingsCard, SettingsGroup } from './SettingsPrimitives';

export interface PeerSharedComputer {
  id: string;
  name: string;
  days: number;
  latest: string;
  enabled: boolean;
}

export interface PeerSharedPulled {
  id: string;
  name: string;
  days: number;
  calls: number;
}

export interface PeerSharedMeta {
  pulledAt: string;
  computers: PeerSharedPulled[];
}

export interface PeerSharedListing {
  computers: PeerSharedComputer[];
  last: PeerSharedMeta | null;
}

type Busy = 'list' | 'pull' | 'clear';

function errorText(cause: unknown) {
  return typeof cause === 'string' ? cause : cause instanceof Error ? cause.message : '操作失败，请稍后重试。';
}

function pulledNote(meta: PeerSharedMeta) {
  if (meta.computers.length === 0) return '没有统计其他电脑的共享用量。';
  const calls = meta.computers.reduce((sum, c) => sum + c.calls, 0);
  return `已统计 ${meta.computers.length} 台电脑的 ${calls} 次调用（${new Date(meta.pulledAt).toLocaleString()}）。`;
}

/**
 * 「数据与帮助」里的其他电脑共享用量：外部网关会把每台电脑每天的调用加密放在同一个
 * WebDAV 文件夹里。默认一台都不统计；只勾选没有装 TokenLedger 的电脑，否则会重复计数。
 * 这些调用只在本机统计里显示，不上传云端。
 */
export function PeerSharedUsageCard() {
  const [listing, setListing] = useState<PeerSharedListing | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<Busy | null>(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');

  const run = async (action: Busy, task: () => Promise<void>) => {
    if (busy) return;
    setBusy(action);
    setError('');
    setNote('');
    try {
      await task();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(null);
    }
  };

  const list = () => run('list', async () => {
    const next = await invoke<PeerSharedListing>('peer_sync_shared_list');
    setListing(next);
    setPicked(new Set(next.computers.filter((c) => c.enabled).map((c) => c.id)));
    if (next.computers.length === 0) setNote('WebDAV 上还没有其他电脑共享的用量。');
    else if (next.last) setNote(pulledNote(next.last));
  });

  const pull = () => run('pull', async () => {
    const meta = await invoke<PeerSharedMeta>('peer_sync_shared_pull', { ids: [...picked] });
    setListing((current) => current && {
      computers: current.computers.map((c) => ({ ...c, enabled: picked.has(c.id) })),
      last: meta,
    });
    setNote(pulledNote(meta));
  });

  const clear = () => run('clear', async () => {
    await invoke('peer_sync_shared_clear');
    setPicked(new Set());
    setListing((current) => current && {
      computers: current.computers.map((c) => ({ ...c, enabled: false })),
      last: null,
    });
    setNote('已停止统计其他电脑的用量，并删除了本机保存的副本。');
  });

  const toggle = (id: string) => {
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <SettingsCard title="其他电脑的共享用量">
      <SettingsGroup>
        <p className="settings-project-copy">
          外部网关会把每台电脑的调用加密放在同一个 WebDAV 文件夹里。只勾选没有安装 TokenLedger 的电脑，否则同一次调用会算两遍。
        </p>
        {error && <p className="settings-project-note" role="alert">{error}</p>}
        {note && <p className="settings-project-note" role="status">{note}</p>}
        <SettingsActionRow busy={busy !== null}>
          <button className="secondary-inline" type="button" onClick={() => void list()} disabled={busy !== null}>
            {busy === 'list' ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Monitor className="h-4 w-4" />}
            {busy === 'list' ? '读取中…' : '查看共享用量的电脑'}
          </button>
          {/* 不依赖服务器：离线或改了密码也能停止统计并删除本机副本。 */}
          <button className="secondary-inline" type="button" onClick={() => void clear()} disabled={busy !== null}>
            <Trash2 className="h-4 w-4" />
            {busy === 'clear' ? '清除中…' : '停止统计并清除'}
          </button>
        </SettingsActionRow>
        {listing && listing.computers.length > 0 && (
          <div className="settings-peer-preview" aria-label="共享用量的电脑">
            <ul className="settings-peer-list">
              {listing.computers.map((c) => (
                <li key={c.id}>
                  <label>
                    <input type="checkbox" checked={picked.has(c.id)} onChange={() => toggle(c.id)} />
                    <span className="settings-peer-name">{c.name || c.id}</span>
                    <span className="settings-peer-meta">{c.days} 天 · 最近 {c.latest}</span>
                  </label>
                </li>
              ))}
            </ul>
            <SettingsActionRow busy={busy !== null}>
              <button className="primary-inline" type="button" onClick={() => void pull()} disabled={busy !== null}>
                {busy === 'pull' ? '同步中…' : picked.size > 0 ? `统计选中的 ${picked.size} 台电脑` : '不统计任何电脑'}
              </button>
            </SettingsActionRow>
          </div>
        )}
        <DisclosurePanel title="了解详情：共享用量">
          <div className="settings-project-copy">
            <ul>
              <li>使用上方「外部网关 WebDAV 同步」里保存的地址和同步密码，只读取，不改动服务器上的文件。</li>
              <li>默认不统计任何电脑；本机自己的那份会自动跳过。外部网关在服务器上保留最近 90 天。</li>
              <li>这些调用按电脑分开记入本机的统计，不会替换本机扫描到的记录，也不会上传到云端。</li>
              <li>需要更新时再点一次「统计选中的电脑」。</li>
            </ul>
          </div>
        </DisclosurePanel>
      </SettingsGroup>
    </SettingsCard>
  );
}
