import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { LogOut, RefreshCw, Stethoscope, Wrench } from 'lucide-react';
import { useT } from '../../i18n';
import { formatNum } from '../../utils/format';
import { SettingsActionRow, SettingsCard, SettingsGroup } from './SettingsPrimitives';

export interface DatabaseFileHealth {
  exists: boolean;
  ok: boolean;
  problems: string[];
  bytes: number;
  walBytes: number;
}

export interface DatabaseRepairNotice {
  at: string;
  automatic: boolean;
  rowsRecovered: number;
  rowsUnreadable: number;
  damagedCopy: string;
}

export interface DatabaseHealthReport {
  checkedAt: string;
  ok: boolean;
  ledger: DatabaseFileHealth;
  ledgerRows: number | null;
  gateway: DatabaseFileHealth;
  repairPending: boolean;
  lastRepair: DatabaseRepairNotice | null;
}

export interface DatabaseRepairOutcome {
  fixed: boolean;
  restartRequired: boolean;
  report: DatabaseHealthReport;
}

type Busy = 'check' | 'repair' | 'quit';

function errorText(cause: unknown, fallback: string) {
  return typeof cause === 'string' ? cause : cause instanceof Error ? cause.message : fallback;
}

function megabytes(bytes: number) {
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

/**
 * 「数据与帮助」里的数据库体检：用 SQLite 自带的完整性检查看账本与网关记账是否损坏，
 * 损坏时先就地重建索引，不够再安排下次启动时把还能读出的行搬进新库（原文件保留）。
 */
export function DatabaseHealthCard() {
  const t = useT();
  const [report, setReport] = useState<DatabaseHealthReport | null>(null);
  const [outcome, setOutcome] = useState<DatabaseRepairOutcome | null>(null);
  const [busy, setBusy] = useState<Busy | null>(null);
  const [error, setError] = useState('');

  const run = async (action: Busy, task: () => Promise<void>) => {
    if (busy) return;
    setBusy(action);
    setError('');
    try {
      await task();
    } catch (cause) {
      setError(errorText(cause, t('backup.error.generic')));
    } finally {
      setBusy(null);
    }
  };

  const check = () => run('check', async () => {
    setOutcome(null);
    setReport(await invoke<DatabaseHealthReport>('local_backup_db_check'));
  });

  const repair = () => run('repair', async () => {
    const next = await invoke<DatabaseRepairOutcome>('local_backup_db_repair');
    setOutcome(next);
    setReport(next.report);
  });

  const quit = () => run('quit', async () => {
    await invoke('local_backup_quit');
  });

  const problems = report ? [...report.ledger.problems, ...report.gateway.problems].slice(0, 5) : [];
  const last = report?.lastRepair ?? null;
  const pending = report?.repairPending || outcome?.restartRequired;
  return (
    <SettingsCard title={t('dbHealth.title')} description={t('dbHealth.description')}>
      <SettingsGroup>
        {report && (
          <p className="settings-project-note" role="status">
            {report.ok
              ? t('dbHealth.ok', {
                rows: report.ledgerRows === null ? '—' : formatNum(report.ledgerRows),
                size: megabytes(report.ledger.bytes + report.ledger.walBytes),
              })
              : t('dbHealth.damaged', {
                which: [!report.ledger.ok && t('dbHealth.ledger'), !report.gateway.ok && t('dbHealth.gateway')].filter(Boolean).join(', '),
              })}
          </p>
        )}
        {problems.length > 0 && (
          <ul className="settings-peer-list" aria-label={t('dbHealth.problems')}>
            {problems.map((problem, index) => (
              <li key={`${index}-${problem}`} className="settings-peer-meta">{problem}</li>
            ))}
          </ul>
        )}
        {outcome?.fixed && <p className="settings-project-note" role="status">{t('dbHealth.fixed')}</p>}
        {pending && <p className="settings-project-note" role="status">{t('dbHealth.pending')}</p>}
        {last && (
          <p className="settings-project-note">
            {t(last.automatic ? 'dbHealth.lastAutomatic' : 'dbHealth.lastManual', {
              at: new Date(last.at).toLocaleString(),
              rows: formatNum(last.rowsRecovered),
              lost: formatNum(last.rowsUnreadable),
              path: last.damagedCopy,
            })}
          </p>
        )}
        {error && <p className="settings-project-note" role="alert">{error}</p>}
        <SettingsActionRow busy={busy !== null}>
          <button className="secondary-inline" type="button" onClick={() => void check()} disabled={busy !== null}>
            {busy === 'check' ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Stethoscope className="h-4 w-4" />}
            {busy === 'check' ? t('dbHealth.checking') : t('dbHealth.check')}
          </button>
          {report && !report.ok && !pending && (
            <button className="primary-inline" type="button" onClick={() => void repair()} disabled={busy !== null}>
              {busy === 'repair' ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Wrench className="h-4 w-4" />}
              {busy === 'repair' ? t('dbHealth.repairing') : t('dbHealth.repair')}
            </button>
          )}
          {pending && (
            <button className="primary-inline" type="button" onClick={() => void quit()} disabled={busy !== null}>
              <LogOut className="h-4 w-4" />
              {t('backup.quit')}
            </button>
          )}
        </SettingsActionRow>
      </SettingsGroup>
    </SettingsCard>
  );
}
