import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Download, RefreshCw, Trash2 } from 'lucide-react';
import { ConfirmDialog } from '../ConfirmDialog';
import { formatNum } from '../../utils/format';
import { DisclosurePanel, SettingsActionRow, SettingsCard, SettingsGroup } from './SettingsPrimitives';

export interface MagpieImportCounts {
  lines: number;
  imported: number;
  invalid: number;
  zeroTokens: number;
  rejected: number;
  otherComputer: number;
  repeated: number;
}

export interface MagpieImportMeta {
  importedAt: string;
  counts: MagpieImportCounts;
  earliest: string | null;
  latest: string | null;
  duplicateOfGateway: number;
  matchedScans: number;
  held: number;
}

export interface MagpieImportStatus {
  sourceFound: boolean;
  usagePath: string | null;
  usageFound: boolean;
  usageBytes: number | null;
  usageModifiedAt: string | null;
  imported: boolean;
  lastImport: MagpieImportMeta | null;
}

function day(value: string | null | undefined) {
  return value ? value.slice(0, 10) : '—';
}

function errorText(cause: unknown) {
  return typeof cause === 'string' ? cause : cause instanceof Error ? cause.message : '操作失败，请稍后重试。';
}

/** 一句话说明导入结果：导入了多少、与本机日志重合多少、有多少因无法确定而未合并。 */
export function magpieImportSummary(meta: MagpieImportMeta): string {
  const parts = [`已导入 ${formatNum(meta.counts.imported)} 次调用（${day(meta.earliest)} ~ ${day(meta.latest)}）`];
  if (meta.matchedScans > 0) parts.push(`其中 ${formatNum(meta.matchedScans)} 条与本机日志重合，按 magpie 记录只算一次`);
  if (meta.duplicateOfGateway > 0) parts.push(`${formatNum(meta.duplicateOfGateway)} 次已由 TokenLedger 网关记录`);
  if (meta.held > 0) parts.push(`${formatNum(meta.held)} 次有多条相同用量的本机日志、无法确定对应哪条，未合并，以本机日志计`);
  return `${parts.join('；')}。`;
}

/**
 * 「数据与帮助」里的 magpie 用量导入。只读 magpie 的 usage.jsonl，
 * 不写 magpie 的任何文件；再次导入会替换上一次导入。
 */
export function MagpieImportCard() {
  const [status, setStatus] = useState<MagpieImportStatus | null>(null);
  const [busy, setBusy] = useState<'import' | 'clear' | null>(null);
  const [error, setError] = useState('');
  const [confirmClear, setConfirmClear] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setStatus(await invoke<MagpieImportStatus>('external_ledger_import_status'));
      setError('');
    } catch (cause) {
      setError(errorText(cause));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = async (action: 'import' | 'clear') => {
    if (busy) return;
    setBusy(action);
    setError('');
    try {
      await invoke(action === 'import' ? 'external_ledger_import_run' : 'external_ledger_import_clear');
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(null);
      await refresh();
    }
  };

  const meta = status?.lastImport ?? null;
  const canImport = status?.usageFound === true;
  return (
    <SettingsCard title="从 magpie 导入">
      <SettingsGroup>
        {status && !status.usageFound && (
          <p className="settings-project-note" role="status">
            {status.sourceFound ? '找到了 magpie，但还没有用量记录。' : '这台电脑上没有找到 magpie。'}
          </p>
        )}
        {meta && <p className="settings-project-note" role="status">{magpieImportSummary(meta)}</p>}
        {error && <p className="settings-project-note" role="alert">{error}</p>}
        <SettingsActionRow busy={busy !== null}>
          <button
            className="primary-inline"
            type="button"
            onClick={() => void run('import')}
            disabled={!canImport || busy !== null}
            aria-busy={busy === 'import' || undefined}
          >
            {busy === 'import' ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            {busy === 'import' ? '导入中…' : status?.imported ? '重新导入' : '一键导入'}
          </button>
          {status?.imported && (
            <button
              className="secondary-inline"
              type="button"
              onClick={() => setConfirmClear(true)}
              disabled={busy !== null}
              aria-busy={busy === 'clear' || undefined}
            >
              <Trash2 className="h-4 w-4" />
              移除导入
            </button>
          )}
        </SettingsActionRow>
        <DisclosurePanel title="了解详情：读取范围与去重">
          <div className="settings-project-copy">
            <ul>
              <li>只读取 magpie 配置目录里的 <code>usage.jsonl</code>，不打开供应商、登录、设置或备份文件，也不改动 magpie 的任何文件。</li>
              <li>只保留统计需要的字段：时间、Agent、供应商、模型、Token 数、耗时与会话 ID；主机、key 名、账号、错误信息和请求 ID 不保存。</li>
              <li>同一次调用若也被 Agent 自己的日志或 TokenLedger 网关记下，只算一次；无法确定对应哪条日志时不合并，以本机日志计。</li>
              <li>导入的记录在用量明细里标为“magpie 导入”，随云同步以小时汇总上传；移除导入即恢复原样。</li>
            </ul>
          </div>
        </DisclosurePanel>
      </SettingsGroup>
      {confirmClear && (
        <ConfirmDialog
          title="移除 magpie 导入？"
          description="将从 TokenLedger 删除已导入的 magpie 用量，magpie 自己的文件不受影响，之后可以重新导入。"
          confirmLabel="移除"
          cancelLabel="取消"
          tone="danger"
          onCancel={() => setConfirmClear(false)}
          onConfirm={() => {
            setConfirmClear(false);
            void run('clear');
          }}
        />
      )}
    </SettingsCard>
  );
}
