import { useId, useMemo, useState } from 'react';
import type { BehaviorAnalysisResponse, BehaviorProject, BehaviorProjectKind } from '../../types';
import { formatNum, formatTokens, formatUsdApprox } from '../../utils/format';
import {
  projectAliasMap,
  projectDisplayName,
  projectFailureCopy,
  unattributedReasonLabel,
} from '../../utils/projectDimension';
import { BEHAVIOR_UNATTRIBUTED_FILTER_KEY } from '../../utils/contracts/behaviorProjects';
import { InfoTip } from '../InfoTip';

type Collecting = Extract<BehaviorAnalysisResponse['meta']['projectDimension'], { state: 'indexing' | 'ready' | 'failed' }>;

function isCollecting(state: string | undefined): state is Collecting['state'] {
  return state === 'indexing' || state === 'ready' || state === 'failed';
}

function formatShare(share: number | null | undefined): string {
  if (typeof share !== 'number' || !Number.isFinite(share) || share < 0) return '—';
  const pct = share * 100;
  if (pct > 0 && pct < 0.1) return '<0.1%';
  return `${pct >= 10 ? pct.toFixed(0) : pct.toFixed(1)}%`;
}

function formatCost(cost: number | null | undefined): string {
  if (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0) return '不可得';
  if (cost === 0) return '≈$0.00';
  if (cost < 0.01) return '<$0.01';
  return formatUsdApprox(cost);
}

export interface BehaviorProjectPanelProps {
  data: BehaviorAnalysisResponse;
  projectFilter?: string[];
  onProjectFilterChange?: (keys: string[]) => void;
  onOpenSettings?: () => void;
  onRebuild?: () => void;
  backfill?: { done: number; total: number } | null;
  hideNames: boolean;
  onHideNamesChange: (hidden: boolean) => void;
}

export function BehaviorProjectPanel({
  data,
  projectFilter = [],
  onProjectFilterChange,
  onOpenSettings,
  onRebuild,
  backfill = null,
  hideNames,
  onHideNamesChange,
}: BehaviorProjectPanelProps) {
  const titleId = useId();
  const [query, setQuery] = useState('');
  const dimension = data.meta.projectDimension;
  const aliases = useMemo(
    () => projectAliasMap(data.projects, data.sessions, hideNames),
    [data.projects, data.sessions, hideNames],
  );

  if (!dimension) return null;

  if (dimension.state === 'disabled' || dimension.state === 'consent_required') {
    const consent = dimension.state === 'consent_required';
    return (
      <section className="panel behavior-project-entry" aria-labelledby={titleId}>
        {/* U-102：卡面只留一句，其余收进 ⓘ。 */}
        <p id={titleId}>{consent ? '按项目统计需要重新确认。' : '按项目查看用量，默认关闭。'}</p>
        <InfoTip label="项目维度说明">
          {consent
            ? '读取范围有更新；确认前不再显示项目。'
            : '开启后只在这台电脑保存文件夹名，不上传。'}
        </InfoTip>
        <button className="secondary-inline" type="button" onClick={onOpenSettings}>
          {consent ? '去设置重新确认' : '了解并开启'}
        </button>
      </section>
    );
  }

  const projects = data.projects ?? [];
  const unattributed = data.unattributed;
  const needle = query.trim().toLocaleLowerCase();
  const visible = projects.filter((project) => {
    if (!needle) return true;
    return projectDisplayName(project, aliases, hideNames).toLocaleLowerCase().includes(needle);
  });
  const showUnattributed = !needle || '未归属'.includes(query.trim());
  const allUnattributed = dimension.state === 'ready' && projects.length === 0 && (unattributed?.tokens ?? 0) > 0;
  const indexingCopy = dimension.state === 'indexing'
    ? (backfill && backfill.total > 0
      ? `正在建立项目索引：已处理 ${backfill.done} / ${backfill.total} 个会话，数字会继续变化`
      : `正在建立项目索引：范围内已有索引 ${dimension.indexedSessions} 个会话，尚有 ${dimension.pendingSessions} 个，数字会继续变化`)
    : null;

  const select = (key: string) => {
    if (!onProjectFilterChange) return;
    onProjectFilterChange(projectFilter.length === 1 && projectFilter[0] === key ? [] : [key]);
  };

  return (
    <section className="panel behavior-project-panel" aria-labelledby={titleId}>
      <div className="behavior-rank-head">
        <h2 id={titleId}>项目 <small>（{projects.length} 个{data.projectsTruncated ? `，另有 ${data.projectsRemainder?.projectCount ?? 0} 个并入其他` : ''}）</small></h2>
        <p className="behavior-rank-caption">
          按文件夹名归并，项目名只存本机。
          <InfoTip label="项目归并说明">一次会话只算入启动时所在的项目。项目名只在这台电脑上，不上传。</InfoTip>
        </p>
      </div>
      <div className="behavior-project-tools">
        <label>
          搜索项目
          <input aria-label="搜索项目" value={query} onChange={(event) => setQuery(event.target.value)} />
        </label>
        <button
          className="ghost-inline"
          type="button"
          role="switch"
          aria-checked={hideNames}
          onClick={() => onHideNamesChange(!hideNames)}
        >
          隐藏项目名
        </button>
        {projectFilter.length > 0 && (
          <button className="ghost-inline" type="button" onClick={() => onProjectFilterChange?.([])}>清除项目筛选</button>
        )}
      </div>
      {indexingCopy && <p className="behavior-rank-note" role="status">{indexingCopy}</p>}
      {dimension.state === 'failed' && (
        <p className="behavior-rank-note is-attention" role="alert">
          {projectFailureCopy(dimension.lastFailure)}
          {onRebuild && <button className="secondary-inline" type="button" onClick={onRebuild}>重试建立索引</button>}
        </p>
      )}
      {allUnattributed && (
        <p className="behavior-rank-note">当前范围内的用量来自不记录工作目录的工具（如 Antigravity、Trae、腾讯 Marvis）。</p>
      )}
      {data.summary.requests === 0 ? (
        <p className="behavior-rank-empty">该区间没有本机账本记录。</p>
      ) : (
        <ol className="behavior-rank-list" role="list" aria-labelledby={titleId}>
          {visible.map((project, index) => (
            <ProjectRow
              key={hideNames ? `row-${index}` : project.key}
              project={project}
              aliases={aliases}
              hideNames={hideNames}
              pressed={projectFilter.includes(project.key)}
              onSelect={() => select(project.key)}
            />
          ))}
          {data.projectsRemainder && data.projectsRemainder.projectCount > 0 && !needle && (
            <li className="behavior-rank-row">
              <div className="behavior-rank-main">
                <span className="behavior-rank-name">其他 {data.projectsRemainder.projectCount} 个项目</span>
                <strong className="behavior-rank-value">{formatTokens(data.projectsRemainder.tokens)}<span className="sr-only"> 有效 Token</span></strong>
                <span className="behavior-rank-meta">{formatShare(data.projectsRemainder.share)} · {formatNum(data.projectsRemainder.sessionCount)} 会话</span>
              </div>
            </li>
          )}
          {showUnattributed && unattributed && unattributed.tokens > 0 && (
            <li className="behavior-rank-row">
              <button
                type="button"
                className="behavior-rank-main"
                aria-pressed={projectFilter.includes(BEHAVIOR_UNATTRIBUTED_FILTER_KEY)}
                onClick={() => select(BEHAVIOR_UNATTRIBUTED_FILTER_KEY)}
              >
                <span className="behavior-rank-name">未归属</span>
                <strong className="behavior-rank-value">{formatTokens(unattributed.tokens)}<span className="sr-only"> 有效 Token</span></strong>
                <span className="behavior-rank-meta">
                  {formatShare(unattributed.share)} · {unattributed.reasons.map((row) => `${unattributedReasonLabel(row.reason)} ${formatTokens(row.tokens)}`).join('，')}
                </span>
              </button>
            </li>
          )}
        </ol>
      )}
    </section>
  );
}

function ProjectRow({
  project,
  aliases,
  hideNames,
  pressed,
  onSelect,
}: {
  project: BehaviorProject;
  aliases: Map<string, string>;
  hideNames: boolean;
  pressed: boolean;
  onSelect: () => void;
}) {
  const name = projectDisplayName(project, aliases, hideNames);
  const share = formatShare(project.share);
  const tool = project.tools[0]?.id;
  return (
    <li className={`behavior-rank-row${project.kind === 'named' ? '' : ' is-fixed-group'}`}>
      <button type="button" className="behavior-rank-main" aria-pressed={pressed} onClick={onSelect}>
        <span className="behavior-rank-name">{name}</span>
        <strong className="behavior-rank-value">{formatTokens(project.tokens)}<span className="sr-only"> 有效 Token</span></strong>
        <span className="behavior-rank-meta">
          {share} · {formatNum(project.sessionCount)} 会话{tool ? ` · ${tool}` : ''} · 预估费用 {formatCost(project.cost)}
        </span>
        <span className="behavior-project-meter" aria-hidden="true"><span style={{ width: `${Math.min(100, Math.round((project.share ?? 0) * 100))}%` }} /></span>
      </button>
    </li>
  );
}

export function SessionProjectChip({
  project,
  reason,
  aliases,
  hidden,
  onSelect,
}: {
  project?: { key: string; label: string | null; kind: BehaviorProjectKind } | null;
  reason?: BehaviorAnalysisResponse['sessions'][number]['projectReason'];
  aliases: Map<string, string>;
  hidden: boolean;
  onSelect?: (key: string) => void;
}) {
  if (project) {
    const name = projectDisplayName(project, aliases, hidden);
    return (
      <button type="button" className="behavior-project-chip" onClick={() => onSelect?.(project.key)}>
        <span className="sr-only">项目 </span>{name}
      </button>
    );
  }
  const why = unattributedReasonLabel(reason);
  return (
    <button type="button" className="behavior-project-chip" aria-label={`未归属，${why}`} onClick={() => onSelect?.(BEHAVIOR_UNATTRIBUTED_FILTER_KEY)}>
      —<span className="sr-only">，{why}</span>
    </button>
  );
}

export function behaviorProjectAliases(data: BehaviorAnalysisResponse | null, hidden: boolean): Map<string, string> {
  return projectAliasMap(data?.projects, data?.sessions, hidden);
}

export function behaviorShowsSessionProject(data: BehaviorAnalysisResponse | null): boolean {
  return isCollecting(data?.meta.projectDimension?.state);
}
