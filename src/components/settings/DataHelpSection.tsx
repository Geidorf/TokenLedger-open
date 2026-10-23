import { useState } from 'react';
import { Cloud, Database, Download, HardDrive, RefreshCw, RotateCcw, Share2, Timer, Trash2 } from 'lucide-react';
import type { BusyState, DbInfo } from '../../types';
import { formatNum } from '../../utils/format';
import {
  DangerZone,
  DisclosurePanel,
  InfoStatRow,
  SettingsActionRow,
  SettingsCard,
  SettingsGroup,
  SettingsSection,
} from './SettingsPrimitives';
import { ProjectDimensionCard } from './ProjectDimensionCard';
import { MagpieImportCard } from './MagpieImportCard';
import { PeerSyncCard } from './PeerSyncCard';

export interface DataHelpSectionProps {
  dbInfo: DbInfo | null;
  dbInfoError: string;
  cloudSetup: {
    configured: boolean;
    authenticated: boolean;
    capabilityVerified: boolean;
    firstSyncCompleted: boolean;
  };
  cleanupDate: string;
  busy: BusyState;
  onExport: () => void | Promise<void>;
  onOpenShareCard?: () => void;
  onRefreshDb: () => void | Promise<void>;
  onCleanupDateChange: (date: string) => void;
  onCleanup: () => void | Promise<void>;
  onReclaimSpace?: () => void | Promise<void>;
  onResetSync: () => void | Promise<void>;
  onOpenCloudSection: () => void;
}

export interface DataSyncGuidance {
  tone: 'attention' | 'ready';
  title: string;
  message: string;
  actionLabel: string;
}

type DataAction = 'export' | 'reset' | 'refresh' | 'cleanup' | 'reclaim';

function prettyBytes(bytes?: number) {
  if (!bytes) return '—';
  return `${(bytes / 1_048_576).toFixed(2)} MB`;
}

/** 清理/去重后 SQLite 只把页挂到空闲链表，文件不会自己变小；这里把它翻译成用户能决策的数字。 */
export function reclaimableSummary(dbInfo: DbInfo | null): { value: string; hint: string } {
  if (!dbInfo || typeof dbInfo.reclaimableBytes !== 'number') {
    return { value: '—', hint: '刷新信息后显示清理留下的空闲页' };
  }
  if (dbInfo.reclaimableBytes < 1_048_576) {
    return { value: '不足 1 MB', hint: '无需回收' };
  }
  const ratio = dbInfo.sizeBytes ? Math.round((dbInfo.reclaimableBytes / dbInfo.sizeBytes) * 100) : 0;
  return { value: prettyBytes(dbInfo.reclaimableBytes), hint: `占体积 ${ratio}%，清理后未归还系统的空闲页` };
}

export function getDataSyncGuidance(
  cloudSetup: DataHelpSectionProps['cloudSetup'],
  unsyncedRecords: number,
): DataSyncGuidance | null {
  if (unsyncedRecords <= 0) return null;
  const countLabel = formatNum(unsyncedRecords);
  if (!cloudSetup.configured) {
    return {
      tone: 'attention',
      title: '同步暂不可用',
      message: `先完成云端连接配置，才能同步 ${countLabel} 条本地记录。`,
      actionLabel: '去连接配置',
    };
  }
  if (!cloudSetup.authenticated) {
    return {
      tone: 'attention',
      title: '同步暂不可用',
      message: `先登录云端账户，才能同步 ${countLabel} 条本地记录。`,
      actionLabel: '去登录云端',
    };
  }
  if (!cloudSetup.capabilityVerified) {
    return {
      tone: 'attention',
      title: '同步暂不可用',
      message: `先验证 Stats v2，才能同步 ${countLabel} 条本地记录。`,
      actionLabel: '去验证 Stats v2',
    };
  }
  if (!cloudSetup.firstSyncCompleted) {
    return {
      tone: 'attention',
      title: '同步暂不可用',
      message: `先完成首次同步，才能上传 ${countLabel} 条本地记录。`,
      actionLabel: '去首次同步',
    };
  }
  return {
    tone: 'ready',
    title: '数据已准备好同步',
    message: `有 ${countLabel} 条本地记录等待同步。`,
    actionLabel: '去云端同步',
  };
}

export function DataHelpSection(props: DataHelpSectionProps) {
  const { dbInfo, busy } = props;
  const hasDbInfoSnapshot = dbInfo !== null;
  const syncGuidance = getDataSyncGuidance(props.cloudSetup, dbInfo?.unsyncedRecords ?? 0);
  const reclaimable = reclaimableSummary(dbInfo);
  const onReclaimSpace = props.onReclaimSpace;
  const [activeAction, setActiveAction] = useState<DataAction | null>(null);

  const runDataAction = async (action: DataAction, callback: () => void | Promise<void>) => {
    if (activeAction !== null || busy.db) return;
    setActiveAction(action);
    try {
      await callback();
    } finally {
      setActiveAction(null);
    }
  };

  const actionBusy = (action: DataAction) => activeAction === action;
  const actionLocked = busy.db || activeAction !== null;
  return (
    <SettingsSection id="data" title="数据与帮助">
      <SettingsCard title="数据库概览">
        {props.dbInfoError && (
          <div className="settings-data-error" role="alert">
            <span>{props.dbInfoError}</span>
            {hasDbInfoSnapshot && (
              <span className="settings-data-error-detail">仍显示上次读取到的本地数据库信息，可点击“刷新信息”重试。</span>
            )}
          </div>
        )}
        <div className="settings-info-grid">
          <InfoStatRow label="总记录" value={dbInfo ? formatNum(dbInfo.totalRecords) : '—'} icon={Database} />
          <InfoStatRow label="未同步" value={dbInfo ? formatNum(dbInfo.unsyncedRecords) : '—'} icon={Cloud} />
          <InfoStatRow label="数据库体积" value={prettyBytes(dbInfo?.sizeBytes)} icon={Database} />
          <InfoStatRow label="可回收空间" value={reclaimable.value} hint={reclaimable.hint} icon={HardDrive} />
          <InfoStatRow
            label="时间跨度"
            value={dbInfo ? `${(dbInfo.earliest || '—').slice(0, 10)} ~ ${(dbInfo.latest || '—').slice(0, 10)}` : '—'}
            hint="当前本地数据库覆盖范围"
            icon={Timer}
          />
        </div>
        {syncGuidance && (
          <div className={`settings-sync-gate settings-sync-gate-${syncGuidance.tone}`}>
            <div className="settings-sync-gate-copy" role="status" aria-live="polite">
              <strong>{syncGuidance.title}</strong>
              <span>{syncGuidance.message}</span>
            </div>
            <button className="secondary-inline" type="button" onClick={props.onOpenCloudSection}>
              {syncGuidance.actionLabel}
            </button>
          </div>
        )}
      </SettingsCard>

      <ProjectDimensionCard />

      <MagpieImportCard />

      <PeerSyncCard />

      <SettingsCard title="导出与分享">
        <SettingsGroup>
          <SettingsActionRow busy={busy.db || activeAction !== null}>
            {props.onOpenShareCard && (
              <button className="primary-inline" type="button" onClick={props.onOpenShareCard} disabled={actionLocked}>
                <Share2 className="h-4 w-4" />
                生成数据战报
              </button>
            )}
            <button
              className="secondary-inline"
              type="button"
              onClick={() => void runDataAction('export', props.onExport)}
              disabled={actionLocked}
              aria-busy={actionBusy('export') || undefined}
              aria-label={activeAction === 'export' ? '正在导出 CSV' : '导出 CSV'}
              title={activeAction === 'export' ? '正在导出 CSV' : '导出 CSV'}
            >
              {activeAction === 'export' ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
              {activeAction === 'export' ? '导出中…' : '导出 CSV'}
            </button>
          </SettingsActionRow>
          {props.onOpenShareCard && (
            <p className="settings-action-hint">HTML 简报在“生成数据战报”弹窗内导出。</p>
          )}
        </SettingsGroup>
      </SettingsCard>

      <SettingsCard title="维护">
        <SettingsGroup>
          <SettingsActionRow busy={actionLocked}>
            <button
              className="secondary-inline"
              type="button"
              onClick={() => void runDataAction('refresh', props.onRefreshDb)}
              disabled={actionLocked}
              aria-busy={actionBusy('refresh') || undefined}
              aria-label={activeAction === 'refresh' ? '正在刷新数据库信息' : '刷新信息'}
              title={activeAction === 'refresh' ? '正在刷新数据库信息' : '重新读取上方的数据库概览'}
            >
              <RefreshCw className={`h-4 w-4 ${activeAction === 'refresh' ? 'animate-spin' : ''}`} />
              {activeAction === 'refresh' ? '刷新中…' : '刷新信息'}
            </button>
            <button
              className="secondary-inline"
              type="button"
              onClick={() => void runDataAction('reset', props.onResetSync)}
              disabled={actionLocked}
              aria-busy={actionBusy('reset') || undefined}
              aria-label={activeAction === 'reset' ? '正在重置同步' : '重置同步'}
              title={activeAction === 'reset' ? '正在重置同步' : '把本机记录全部标记为未同步，下次同步重新上传'}
            >
              {activeAction === 'reset' ? <RefreshCw className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
              {activeAction === 'reset' ? '重置中…' : '重置同步'}
            </button>
            {onReclaimSpace && (
              <button
                className="secondary-inline"
                type="button"
                onClick={() => void runDataAction('reclaim', onReclaimSpace)}
                disabled={actionLocked}
                aria-busy={actionBusy('reclaim') || undefined}
                aria-label={activeAction === 'reclaim' ? '正在回收空间' : '回收空间'}
                title={activeAction === 'reclaim' ? '正在回收数据库空闲空间' : '重写数据库文件，归还清理后留下的空闲页'}
              >
                {activeAction === 'reclaim' ? <RefreshCw className="h-4 w-4 animate-spin" /> : <HardDrive className="h-4 w-4" />}
                {activeAction === 'reclaim' ? '回收中…' : '回收空间'}
              </button>
            )}
          </SettingsActionRow>
          <p className="settings-action-hint">重置同步会在下次同步时重新上传全部记录，执行前会确认；回收空间不改动数据。</p>
        </SettingsGroup>
      </SettingsCard>

      <SettingsCard title="清理旧数据">
        <SettingsGroup>
          <DangerZone>
            <SettingsActionRow busy={busy.db || activeAction !== null}>
              <input
                className="settings-input settings-date-input"
                type="date"
                value={props.cleanupDate}
                aria-label="清理截止日期"
                onChange={(event) => props.onCleanupDateChange(event.target.value)}
                disabled={busy.db}
              />
              <button
                className="danger-inline"
                type="button"
                onClick={() => void runDataAction('cleanup', props.onCleanup)}
                disabled={actionLocked || !props.cleanupDate}
                aria-busy={actionBusy('cleanup') || undefined}
                aria-label={activeAction === 'cleanup' ? '正在清理旧数据' : '清理旧数据'}
                title={activeAction === 'cleanup' ? '正在清理旧数据' : '清理旧数据'}
              >
                {activeAction === 'cleanup' ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                {activeAction === 'cleanup' ? '清理中…' : '清理旧数据'}
              </button>
            </SettingsActionRow>
            <p className="settings-action-hint">删除所选日期之前的记录，执行前会再次确认，不可撤销。</p>
          </DangerZone>
        </SettingsGroup>
      </SettingsCard>

      <SettingsCard title="关于 TokenLedger">
        <SettingsGroup>
          <DisclosurePanel title="支持的本地扫描源与契约说明">
            <p className="settings-text">
              TokenLedger 支持本地扫描 Claude Code、Codex CLI、OpenCode Interpreter、Cursor、Antigravity 等主流 AI 开发工具的日志文件，采用统一的 <code>Effective Tokens = Input + Output</code> 与独立缓存读写契约规范进行精确统计。
            </p>
          </DisclosurePanel>
        </SettingsGroup>
      </SettingsCard>
    </SettingsSection>
  );
}

export default DataHelpSection;
