import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Monitor, RefreshCw, Trash2 } from 'lucide-react';
import { DisclosurePanel, SettingsActionRow, SettingsCard, SettingsGroup } from './SettingsPrimitives';
import { t, useLang } from '../../i18n';

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
  return typeof cause === 'string' ? cause : cause instanceof Error ? cause.message : t('peer.error');
}

function pulledNote(meta: PeerSharedMeta) {
  if (meta.computers.length === 0) return t('peer.none');
  const calls = meta.computers.reduce((sum, c) => sum + c.calls, 0);
  return t('peer.pulled', { computers: meta.computers.length, calls, at: new Date(meta.pulledAt).toLocaleString() });
}

/**
 * 「数据与帮助」里的其他电脑共享用量：外部网关会把每台电脑每天的调用加密放在同一个
 * WebDAV 文件夹里。默认一台都不统计；只勾选没有装 TokenLedger 的电脑，否则会重复计数。
 * 这些调用只在本机统计里显示，不上传云端。
 */
export function PeerSharedUsageCard() {
  useLang();
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
    if (next.computers.length === 0) setNote(t('peer.emptyRemote'));
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
    setNote(t('peer.cleared'));
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
    <SettingsCard title={t('peer.title')}>
      <SettingsGroup>
        <p className="settings-project-copy">
          {t('peer.intro')}
        </p>
        {error && <p className="settings-project-note" role="alert">{error}</p>}
        {note && <p className="settings-project-note" role="status">{note}</p>}
        <SettingsActionRow busy={busy !== null}>
          <button className="secondary-inline" type="button" onClick={() => void list()} disabled={busy !== null}>
            {busy === 'list' ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Monitor className="h-4 w-4" />}
            {busy === 'list' ? t('peer.listing') : t('peer.list')}
          </button>
          {/* 不依赖服务器：离线或改了密码也能停止统计并删除本机副本。 */}
          <button className="secondary-inline" type="button" onClick={() => void clear()} disabled={busy !== null}>
            <Trash2 className="h-4 w-4" />
            {busy === 'clear' ? t('peer.clearing') : t('peer.clear')}
          </button>
        </SettingsActionRow>
        {listing && listing.computers.length > 0 && (
          <div className="settings-peer-preview" aria-label={t('peer.region')}>
            <ul className="settings-peer-list">
              {listing.computers.map((c) => (
                <li key={c.id}>
                  <label>
                    <input type="checkbox" checked={picked.has(c.id)} onChange={() => toggle(c.id)} />
                    <span className="settings-peer-name">{c.name || c.id}</span>
                    <span className="settings-peer-meta">{t('peer.meta', { days: c.days, latest: c.latest })}</span>
                  </label>
                </li>
              ))}
            </ul>
            <SettingsActionRow busy={busy !== null}>
              <button className="primary-inline" type="button" onClick={() => void pull()} disabled={busy !== null}>
                {busy === 'pull' ? t('peer.pulling') : picked.size > 0 ? t('peer.pullSome', { count: picked.size }) : t('peer.pullNone')}
              </button>
            </SettingsActionRow>
          </div>
        )}
        <DisclosurePanel title={t('peer.details')}>
          <div className="settings-project-copy">
            <ul>
              <li>{t('peer.detail1')}</li>
              <li>{t('peer.detail2')}</li>
              <li>{t('peer.detail3')}</li>
              <li>{t('peer.detail4')}</li>
            </ul>
          </div>
        </DisclosurePanel>
      </SettingsGroup>
    </SettingsCard>
  );
}
