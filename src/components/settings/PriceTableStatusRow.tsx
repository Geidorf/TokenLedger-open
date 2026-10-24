import { useCallback, useEffect, useState } from 'react';
import { CloudDownload, RefreshCw } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import type { PriceTableStatus } from '../../types';
import {
  describePriceTableCheck,
  describePriceTableSource,
  parsePriceTableStatus,
} from '../../utils/priceTableStatus';
import { SettingsRow, SettingsToggleRow } from './SettingsPrimitives';

/**
 * 设置 → 模型价格：默认价格表的出处（内置或在线更新）、修订与核验日期，以及每日在线
 * 更新的开关与「检查更新」。读取失败时整块不显示，不影响下面的价格编辑。
 * 检查到新表时后端发 `prices-updated`：编辑器没有未保存修改就重新读取，有就提示，
 * 不在这里替换编辑框内容。
 */
export function PriceTableStatusRow({ refreshKey = '' }: {
  /** 编辑器载入、保存或恢复默认后会变：出处与覆盖数随之重读。 */
  refreshKey?: string;
}) {
  const [status, setStatus] = useState<PriceTableStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [updates, setUpdates] = useState(0);

  useEffect(() => {
    let active = true;
    Promise.resolve()
      .then(() => invoke<unknown>('get_price_table_status'))
      .then((value) => { if (active) setStatus(parsePriceTableStatus(value)); })
      .catch(() => { if (active) setStatus(null); });
    return () => { active = false; };
  }, [refreshKey, updates]);

  // 后台定时更新换了表时，编辑框有未保存修改就不会重载，所以这里自己听事件更新出处。
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    const install = async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');
        const cleanup = await listen('prices-updated', () => setUpdates((n) => n + 1));
        if (cancelled) cleanup();
        else unlisten = cleanup;
      } catch {
        // 浏览器 fixture 没有原生事件桥。
      }
    };
    void install();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const check = useCallback(async () => {
    setChecking(true);
    try {
      const next = parsePriceTableStatus(await invoke<unknown>('check_price_table_update'));
      if (next) setStatus(next);
    } catch {
      // 状态保持不变；失败原因由下一次读取的 lastError 给出。
    } finally {
      setChecking(false);
    }
  }, []);

  const toggle = useCallback(async (enabled: boolean) => {
    setSaving(true);
    try {
      const next = parsePriceTableStatus(await invoke<unknown>('set_price_table_auto_update', { enabled }));
      if (next) setStatus(next);
    } catch {
      // 保持原值。
    } finally {
      setSaving(false);
    }
  }, []);

  if (!status) return null;
  return (
    <>
      <SettingsRow label="价格来源" hint={describePriceTableSource(status)} icon={CloudDownload}>
        <button
          className="secondary-inline"
          type="button"
          onClick={() => void check()}
          disabled={checking}
          aria-busy={checking || undefined}
          title={describePriceTableCheck(status)}
        >
          <RefreshCw className={`h-4 w-4 ${checking ? 'animate-spin' : ''}`} />
          {checking ? '检查中…' : '检查更新'}
        </button>
      </SettingsRow>
      <SettingsToggleRow
        label="每天自动更新价格表"
        hint={`只下载公开的价格表，不上传任何数据；调价只作用于生效日之后的记录。${describePriceTableCheck(status)}`}
        icon={RefreshCw}
        checked={status.autoUpdate}
        busy={saving}
        onChange={(enabled) => void toggle(enabled)}
      />
    </>
  );
}

export default PriceTableStatusRow;
