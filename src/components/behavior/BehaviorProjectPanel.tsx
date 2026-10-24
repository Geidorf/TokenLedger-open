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
import { t, useLang } from '../../i18n';

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
  if (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0) return t('projectPanel.unavailable');
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
  const lang = useLang();
  const [query, setQuery] = useState('');
  const dimension = data.meta.projectDimension;
  // 代称「项目 1」随界面语言变化，`lang` 进依赖以便切换后重建。
  const aliases = useMemo(
    () => projectAliasMap(data.projects, data.sessions, hideNames),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data.projects, data.sessions, hideNames, lang],
  );

  if (!dimension) return null;

  if (dimension.state === 'disabled' || dimension.state === 'consent_required') {
    const consent = dimension.state === 'consent_required';
    return (
      <section className="panel behavior-project-entry" aria-labelledby={titleId}>
        {/* U-102：卡面只留一句，其余收进 ⓘ。 */}
        <p id={titleId}>{t(consent ? 'projectPanel.consentTitle' : 'projectPanel.offTitle')}</p>
        <InfoTip label={t('projectPanel.infoLabel')}>
          {t(consent ? 'projectPanel.consentInfo' : 'projectPanel.offInfo')}
        </InfoTip>
        <button className="secondary-inline" type="button" onClick={onOpenSettings}>
          {t(consent ? 'projectPanel.reconfirm' : 'projectPanel.enable')}
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
  const showUnattributed = !needle || t('projectPanel.unattributed').toLocaleLowerCase().includes(needle);
  const allUnattributed = dimension.state === 'ready' && projects.length === 0 && (unattributed?.tokens ?? 0) > 0;
  const indexingCopy = dimension.state === 'indexing'
    ? (backfill && backfill.total > 0
      ? t('projectPanel.indexingDone', { done: backfill.done, total: backfill.total })
      : t('projectPanel.indexingRange', { indexed: dimension.indexedSessions, pending: dimension.pendingSessions }))
    : null;

  const select = (key: string) => {
    if (!onProjectFilterChange) return;
    onProjectFilterChange(projectFilter.length === 1 && projectFilter[0] === key ? [] : [key]);
  };

  return (
    <section className="panel behavior-project-panel" aria-labelledby={titleId}>
      <div className="behavior-rank-head">
        <h2 id={titleId}>{t('projectPanel.title')} <small>{data.projectsTruncated ? t('projectPanel.countMore', { count: projects.length, more: data.projectsRemainder?.projectCount ?? 0 }) : t('projectPanel.count', { count: projects.length })}</small></h2>
        <p className="behavior-rank-caption">
          {t('projectPanel.caption')}
          <InfoTip label={t('projectPanel.mergeInfoLabel')}>{t('projectPanel.mergeInfo')}</InfoTip>
        </p>
      </div>
      <div className="behavior-project-tools">
        <label>
          {t('projectPanel.search')}
          <input aria-label={t('projectPanel.search')} value={query} onChange={(event) => setQuery(event.target.value)} />
        </label>
        <button
          className="ghost-inline"
          type="button"
          role="switch"
          aria-checked={hideNames}
          onClick={() => onHideNamesChange(!hideNames)}
        >
          {t('projectPanel.hideNames')}
        </button>
        {projectFilter.length > 0 && (
          <button className="ghost-inline" type="button" onClick={() => onProjectFilterChange?.([])}>{t('projectPanel.clearFilter')}</button>
        )}
      </div>
      {indexingCopy && <p className="behavior-rank-note" role="status">{indexingCopy}</p>}
      {dimension.state === 'failed' && (
        <p className="behavior-rank-note is-attention" role="alert">
          {projectFailureCopy(dimension.lastFailure)}
          {onRebuild && <button className="secondary-inline" type="button" onClick={onRebuild}>{t('projectPanel.retry')}</button>}
        </p>
      )}
      {allUnattributed && (
        <p className="behavior-rank-note">{t('projectPanel.allUnattributed')}</p>
      )}
      {data.summary.requests === 0 ? (
        <p className="behavior-rank-empty">{t('projectPanel.empty')}</p>
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
                <span className="behavior-rank-name">{t('projectPanel.other', { count: data.projectsRemainder.projectCount })}</span>
                <strong className="behavior-rank-value">{formatTokens(data.projectsRemainder.tokens)}<span className="sr-only">{t('projectPanel.tokensSr')}</span></strong>
                <span className="behavior-rank-meta">{formatShare(data.projectsRemainder.share)} · {t('projectPanel.sessions', { count: formatNum(data.projectsRemainder.sessionCount) })}</span>
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
                <span className="behavior-rank-name">{t('projectPanel.unattributed')}</span>
                <strong className="behavior-rank-value">{formatTokens(unattributed.tokens)}<span className="sr-only">{t('projectPanel.tokensSr')}</span></strong>
                <span className="behavior-rank-meta">
                  {formatShare(unattributed.share)} · {unattributed.reasons.map((row) => `${unattributedReasonLabel(row.reason)} ${formatTokens(row.tokens)}`).join(t('projectPanel.reasonJoin'))}
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
        <strong className="behavior-rank-value">{formatTokens(project.tokens)}<span className="sr-only">{t('projectPanel.tokensSr')}</span></strong>
        <span className="behavior-rank-meta">
          {share} · {t('projectPanel.sessions', { count: formatNum(project.sessionCount) })}{tool ? ` · ${tool}` : ''} · {t('projectPanel.cost', { cost: formatCost(project.cost) })}
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
        <span className="sr-only">{t('projectPanel.projectSr')}</span>{name}
      </button>
    );
  }
  const why = unattributedReasonLabel(reason);
  return (
    <button type="button" className="behavior-project-chip" aria-label={t('projectPanel.chipAria', { why })} onClick={() => onSelect?.(BEHAVIOR_UNATTRIBUTED_FILTER_KEY)}>
      —<span className="sr-only">{t('projectPanel.chipSr', { why })}</span>
    </button>
  );
}

export function behaviorProjectAliases(data: BehaviorAnalysisResponse | null, hidden: boolean): Map<string, string> {
  return projectAliasMap(data?.projects, data?.sessions, hidden);
}

export function behaviorShowsSessionProject(data: BehaviorAnalysisResponse | null): boolean {
  return isCollecting(data?.meta.projectDimension?.state);
}
