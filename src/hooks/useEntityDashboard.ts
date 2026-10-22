import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { DetailFilters } from '../components/LogsTable';
import {
  beginRequest,
  filtersForEntityDrilldown,
  hasCloudCapability,
  invalidateRequest,
  isCurrentRequest,
  isUnavailableEnvelope,
  normalizeEntitySelector,
  normalizeStatsQuery,
  queryEchoMatches,
} from '../utils/frontendContracts';
import {
  CustomDateRange,
  DataScope,
  EntityDashboard,
  EntityDashboardEnvelope,
  EntityDashboardQuery,
  ModelStat,
  RangeKey,
  StatsData,
  Tab,
  ToastMessage,
  ToolStat,
} from '../types';
import { unavailableMessage } from './useUsageDetails';

export interface EntitySelection {
  kind: 'tool' | 'model';
  name: string;
  tool?: string;
  machine?: string;
  filters: DetailFilters;
}

export interface UseEntityDashboardProps {
  dataScope: DataScope;
  range: RangeKey;
  /** `range === 'custom'` 时的日期闭区间；其余范围忽略。 */
  customRange?: CustomDateRange | null;
  deviceFilter: string;
  activeTab: Tab;
  detailFilters: DetailFilters;
  setDetailFilters: (filters: DetailFilters) => void;
  stats: StatsData | null;
  currentTimezone: () => string;
  setMessage: (msg: ToastMessage | null) => void;
  changeTab: (tab: Tab, reset?: boolean) => void;
}

export function useEntityDashboard({
  dataScope,
  range,
  customRange = null,
  deviceFilter,
  activeTab,
  detailFilters,
  setDetailFilters,
  stats,
  currentTimezone,
  setMessage,
  changeTab,
}: UseEntityDashboardProps) {
  const [entitySelection, setEntitySelection] = useState<EntitySelection | null>(null);
  const [entityDashboard, setEntityDashboard] = useState<EntityDashboard | null>(null);
  const [entityLoading, setEntityLoading] = useState(false);
  const [entityError, setEntityError] = useState('');
  const [entityRetryNonce, setEntityRetryNonce] = useState(0);
  const entityRequestId = useRef(0);

  useEffect(() => {
    if (!entitySelection) {
      invalidateRequest(entityRequestId);
      setEntityDashboard(null);
      setEntityError('');
      return;
    }
    const requestId = beginRequest(entityRequestId);
    setEntityLoading(true);
    setEntityError('');
    setEntityDashboard(null);
    const entity = normalizeEntitySelector({ kind: entitySelection.kind, id: entitySelection.name });
    const canonicalQuery = normalizeStatsQuery({
      range,
      start: customRange?.start,
      end: customRange?.end,
      timezone: currentTimezone(),
      machines: entitySelection.filters.machines,
      tools: entitySelection.kind === 'tool' ? [] : entitySelection.filters.tools,
      models: entitySelection.kind === 'model' ? [] : entitySelection.filters.models,
      search: entitySelection.filters.search,
      tokenMode: 'effective',
    });
    const query: EntityDashboardQuery = { scope: dataScope, entity, ...canonicalQuery };
    invoke<EntityDashboardEnvelope>('get_entity_dashboard', { query })
      .then((response) => {
        if (!isCurrentRequest(entityRequestId, requestId)) return;
        const unavailable = unavailableMessage(response, '当前数据源不支持专属看板。');
        if (isUnavailableEnvelope(response)) throw new Error(unavailable || '当前数据源不支持专属看板。');
        if (!queryEchoMatches(response.meta?.query, canonicalQuery, response.meta?.entity, entity)) {
          throw new Error('专属看板响应与当前实体或筛选不一致，请重试。');
        }
        if (!queryEchoMatches(
          response.historyPage.meta?.query,
          canonicalQuery,
          response.historyPage.meta?.entity,
          entity,
        )) {
          throw new Error('专属看板明细与当前实体或筛选不一致，请重试。');
        }
        setEntityDashboard(response);
      })
      .catch((err) => {
        if (!isCurrentRequest(entityRequestId, requestId)) return;
        setEntityError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (isCurrentRequest(entityRequestId, requestId)) setEntityLoading(false);
      });
  }, [currentTimezone, customRange, dataScope, entityRetryNonce, entitySelection, range]);

  const openEntity = useCallback((kind: 'tool' | 'model', name: string, tool?: string, machine?: string) => {
    const cloudEntitySupported = hasCloudCapability(stats, 'entityDashboard');
    if (dataScope === 'cloud' && !cloudEntitySupported) {
      setMessage({ type: 'info', text: '当前云端仍使用旧版统计契约，专属看板入口已停用。请联系部署负责人发布最新迁移，或切换到本地机器。' });
      return;
    }
    let inheritedFilters: DetailFilters = activeTab === 'logs'
      ? {
          tools: [...detailFilters.tools],
          models: [...detailFilters.models],
          machines: [...detailFilters.machines],
          search: detailFilters.search,
        }
      : { tools: [], models: [], machines: [], search: '' };
    if (machine) inheritedFilters.machines = [machine];
    else if (inheritedFilters.machines.length === 0 && dataScope === 'cloud' && deviceFilter !== 'all_cloud') {
      inheritedFilters.machines = [deviceFilter];
    }
    inheritedFilters = filtersForEntityDrilldown(inheritedFilters, kind, tool);
    const displayTool = kind === 'model'
      ? tool || (inheritedFilters.tools.length === 1 ? inheritedFilters.tools[0] : undefined)
      : undefined;
    setEntitySelection({
      kind,
      name,
      tool: displayTool,
      machine: inheritedFilters.machines.length === 1 ? inheritedFilters.machines[0] : undefined,
      filters: inheritedFilters,
    });
  }, [activeTab, dataScope, detailFilters, deviceFilter, setMessage, stats]);

  const openToolEntity = useCallback((tool: ToolStat) => openEntity('tool', tool.name), [openEntity]);
  const openModelEntity = useCallback((model: ModelStat) => openEntity('model', model.name), [openEntity]);

  const openEntityDetails = useCallback((machine?: string) => {
    if (!entitySelection) return;
    setDetailFilters({
      tools: entitySelection.kind === 'tool'
        ? [entitySelection.name]
        : entitySelection.filters.tools,
      models: entitySelection.kind === 'model'
        ? [entitySelection.name]
        : entitySelection.filters.models,
      machines: machine ? [machine] : entitySelection.filters.machines,
      search: entitySelection.filters.search,
    });
    setEntitySelection(null);
    changeTab('logs', true);

    // The modal's focused control is removed at the same time as the tab
    // changes, so the browser would otherwise fall back to BODY. Keep the
    // destination discoverable for keyboard and screen-reader users even
    // while the lazy details surface is still mounting.
    if (typeof window !== 'undefined' && typeof document !== 'undefined') {
      let attempts = 0;
      const focusDetailsHeading = () => {
        const heading = document.getElementById('details-page-title');
        if (heading instanceof HTMLElement) {
          heading.focus({ preventScroll: true });
          return;
        }
        if (attempts < 60) {
          attempts += 1;
          window.requestAnimationFrame(focusDetailsHeading);
        }
      };
      window.requestAnimationFrame(focusDetailsHeading);
    }
  }, [changeTab, entitySelection, setDetailFilters]);

  const openNestedEntity = useCallback((kind: 'tool' | 'model', name: string, tool?: string) => {
    if (!entitySelection) return;
    const inheritedFilters: DetailFilters = {
      tools: [...entitySelection.filters.tools],
      models: [...entitySelection.filters.models],
      machines: [...entitySelection.filters.machines],
      search: entitySelection.filters.search,
    };
    const filters = filtersForEntityDrilldown(inheritedFilters, kind, tool);
    setEntitySelection({
      kind,
      name,
      tool: kind === 'model' ? tool || (filters.tools.length === 1 ? filters.tools[0] : undefined) : undefined,
      machine: filters.machines.length === 1 ? filters.machines[0] : undefined,
      filters,
    });
  }, [entitySelection]);

  return {
    entitySelection,
    setEntitySelection,
    entityDashboard,
    setEntityDashboard,
    entityLoading,
    entityError,
    setEntityError,
    entityRetryNonce,
    setEntityRetryNonce,
    entityRequestId,
    openEntity,
    openToolEntity,
    openModelEntity,
    openEntityDetails,
    openNestedEntity,
  };
}
