import type {
  BehaviorProjectDimensionState,
  BehaviorProjectKind,
  BehaviorSessionProjectReason,
  BehaviorUnattributedReason,
} from '../types';

/** 授权版本 1：git 探测关闭，并读取三类元数据文件（T10.165，ADR-016）。 */
export const PROJECT_DIMENSION_CONSENT_VERSION = 1;

export const PROJECT_DIMENSION_CARD_ID = 'project-dimension';

const FOCUS_KEY = 'tokenledger.focusProjectDimension';

export type ProjectDimensionState = BehaviorProjectDimensionState;

export interface ProjectDimensionBackfill {
  status: string;
  done: number;
  total: number;
}

export interface ProjectDimensionPurge {
  removedSessions: number;
  walTruncated: boolean;
}

/**
 * `get_project_dimension_status` / `set_project_dimension` / `rebuild_project_index`
 * 的返回值，也是 `project-index-updated` 的负载。只含计数与原因码，不含项目名。
 */
export interface ProjectDimensionStatus {
  enabled: boolean;
  state: ProjectDimensionState;
  consentVersion: number;
  requiredConsentVersion: number;
  gitProbeEnabled: boolean;
  backfill: ProjectDimensionBackfill;
  indexedSessions: number;
  namedProjects: number;
  unresolvedSessions: number;
  lastFailure: string | null;
  purge: ProjectDimensionPurge | null;
}

const STATES = new Set<ProjectDimensionState>(['disabled', 'consent_required', 'indexing', 'ready', 'failed']);

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** 拒绝残缺负载，避免把未知响应当成“已开启”。 */
export function parseProjectDimensionStatus(raw: unknown): ProjectDimensionStatus | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.enabled !== 'boolean') return null;
  if (typeof value.state !== 'string' || !STATES.has(value.state as ProjectDimensionState)) return null;
  const consentVersion = finiteNumber(value.consentVersion);
  const requiredConsentVersion = finiteNumber(value.requiredConsentVersion);
  if (consentVersion === null || requiredConsentVersion === null) return null;
  if (typeof value.gitProbeEnabled !== 'boolean') return null;
  if (!value.backfill || typeof value.backfill !== 'object') return null;
  const backfill = value.backfill as Record<string, unknown>;
  const done = finiteNumber(backfill.done);
  const total = finiteNumber(backfill.total);
  if (typeof backfill.status !== 'string' || done === null || total === null) return null;
  const indexedSessions = finiteNumber(value.indexedSessions);
  const namedProjects = finiteNumber(value.namedProjects);
  const unresolvedSessions = finiteNumber(value.unresolvedSessions);
  if (indexedSessions === null || namedProjects === null || unresolvedSessions === null) return null;
  if (value.lastFailure !== null && value.lastFailure !== undefined && typeof value.lastFailure !== 'string') return null;
  let purge: ProjectDimensionPurge | null = null;
  if (value.purge !== undefined && value.purge !== null) {
    if (typeof value.purge !== 'object') return null;
    const report = value.purge as Record<string, unknown>;
    const removedSessions = finiteNumber(report.removedSessions);
    if (removedSessions === null || typeof report.walTruncated !== 'boolean') return null;
    purge = { removedSessions, walTruncated: report.walTruncated };
  }
  return {
    enabled: value.enabled,
    state: value.state as ProjectDimensionState,
    consentVersion,
    requiredConsentVersion,
    gitProbeEnabled: value.gitProbeEnabled,
    backfill: { status: backfill.status, done, total },
    indexedSessions,
    namedProjects,
    unresolvedSessions,
    lastFailure: typeof value.lastFailure === 'string' ? value.lastFailure : null,
    purge,
  };
}

export function projectCommandError(cause: unknown): string {
  const code = String(cause);
  if (code.includes('consent_version_mismatch')) return '授权版本不一致，请重新确认后再开启。';
  if (code.includes('project_dimension_disabled')) return '按项目统计尚未开启。';
  if (code.includes('database_error')) return '本机数据库暂时无法完成操作，请稍后重试。';
  if (code.includes('project_index_task_failed')) return '项目索引任务没有完成，请重试。';
  return '暂时无法更新按项目统计，请重试。';
}

export function projectFailureCopy(code: string | null | undefined): string {
  if (code === 'database_error') return '本机数据库暂时无法建立项目索引。';
  if (code === 'internal_error') return '建立项目索引时发生内部错误。';
  if (code === 'purge_pending') return '项目名已删除，数据库日志中的残留将在下次扫描时清除。';
  return '建立项目索引没有完成。';
}

export const FIXED_PROJECT_LABELS: Record<Exclude<BehaviorProjectKind, 'named'>, string> = {
  home: '主目录',
  root: '磁盘根目录',
  temp: '临时目录',
  managed: '托管会话',
};

export const UNATTRIBUTED_REASON_LABELS: Record<BehaviorUnattributedReason, string> = {
  unsupported_source: '来源不记录工作目录',
  unresolved: '无法确定工作目录',
  pending: '尚未建立索引',
  missing_session: '缺少会话 ID',
};

export function unattributedReasonLabel(reason: BehaviorSessionProjectReason | BehaviorUnattributedReason | undefined): string {
  if (!reason) return '无法归属到项目';
  return UNATTRIBUTED_REASON_LABELS[reason];
}

export function projectAliasMap(
  projects: Array<{ key: string; kind: string }> | undefined,
  sessions: Array<{ project?: { key: string; kind: string } | null }> | undefined,
  hidden: boolean,
): Map<string, string> {
  const map = new Map<string, string>();
  if (!hidden) return map;
  const assign = (key: string, kind: string) => {
    if (kind !== 'named' || map.has(key)) return;
    map.set(key, `项目 ${map.size + 1}`);
  };
  for (const project of projects ?? []) assign(project.key, project.kind);
  for (const session of sessions ?? []) {
    if (session.project) assign(session.project.key, session.project.kind);
  }
  return map;
}

/** 隐藏时只返回代称或固定分组名，不回退到文件夹名。 */
export function projectDisplayName(
  ref: { key: string; label: string | null; kind: BehaviorProjectKind },
  aliases: Map<string, string>,
  hidden: boolean,
): string {
  if (ref.kind !== 'named') return FIXED_PROJECT_LABELS[ref.kind];
  if (hidden) return aliases.get(ref.key) ?? '项目';
  const label = ref.label?.trim();
  return label || '未命名项目';
}

export function requestProjectDimensionFocus(): void {
  try {
    sessionStorage.setItem(FOCUS_KEY, '1');
  } catch {
    /* 定位失败时仍会打开「数据与帮助」。 */
  }
}

export function consumeProjectDimensionFocus(): boolean {
  try {
    if (sessionStorage.getItem(FOCUS_KEY) !== '1') return false;
    sessionStorage.removeItem(FOCUS_KEY);
    return true;
  } catch {
    return false;
  }
}
